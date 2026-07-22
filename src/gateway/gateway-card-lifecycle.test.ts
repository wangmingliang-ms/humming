import { describe, expect, it, vi } from "vitest";
import type { BindingStore } from "../binding-store/binding-store.js";
import type { LarkLogger } from "../logger/logger.js";
import type { LarkPresenter } from "../presenter/presenter.js";
import type { SessionStore } from "../session-store/session-store.js";
import type { LifecycleTransaction } from "../../bin/lifecycle-coordinator.js";
import type { DrainResult } from "./chat-runtime.js";
import { LarkGateway } from "./gateway.js";

const logger: LarkLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
};

function makeGateway(presenter: LarkPresenter = {} as LarkPresenter): LarkGateway {
  return new LarkGateway({
    lark: { appId: "test", appSecret: "test" },
    agent: {
      resolver: () => ({ command: "test", args: [], label: "test" }),
    },
    bindingStore: {} as BindingStore,
    sessionStore: {} as SessionStore,
    presenter,
    logger,
  });
}

function dispatchCardAction(gateway: LarkGateway, value: object): void {
  const testable = gateway as unknown as {
    handleCardAction(event: {
      readonly action: { readonly value: object };
      readonly messageId: string;
    }): void;
  };
  testable.handleCardAction({ action: { value }, messageId: "message" });
}

describe("LarkGateway shutdown", () => {
  it("closes the Lark event stream when the gateway stops", async () => {
    const closeWs = vi.fn();
    const closeSessionStore = vi.fn(async () => {});
    const closeBindingStore = vi.fn(async () => {});
    const gateway = new LarkGateway({
      lark: { appId: "test", appSecret: "test" },
      agent: { resolver: () => ({ command: "test", args: [], label: "test" }) },
      bindingStore: { close: closeBindingStore } as unknown as BindingStore,
      sessionStore: { close: closeSessionStore } as unknown as SessionStore,
      presenter: {} as LarkPresenter,
      logger,
    });
    const testable = gateway as unknown as {
      started: boolean;
      ws: { close(): void } | null;
    };
    testable.started = true;
    testable.ws = { close: closeWs };

    await gateway.stop();

    expect(closeWs).toHaveBeenCalledOnce();
  });
});

describe("LarkGateway prompt ingress ordering", () => {
  it("quiesces ingress synchronously and waits for every runtime before lifecycle notice", async () => {
    const notices: Array<{ title: string; body: string }> = [];
    const presenter = {
      replyNoticeCard: vi.fn(
        async (_messageId: string, notice: { title: string; body: string }) => {
          notices.push(notice);
          return "notice";
        },
      ),
    } as unknown as LarkPresenter;
    const gateway = makeGateway(presenter);
    const events: string[] = [];
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const drained = (intent: "stop" | "restart"): DrainResult => ({
      intent,
      outcome: "drained",
      cancel: "sent",
      persisted: true,
      agentClose: "closed",
    });
    const first = {
      drain: vi.fn(async (intent: "stop" | "restart") => {
        events.push("first:start");
        await firstGate;
        events.push("first:end");
        return drained(intent);
      }),
    };
    const second = {
      drain: vi.fn(async (intent: "stop" | "restart") => {
        events.push("second:start");
        await secondGate;
        events.push("second:end");
        return drained(intent);
      }),
    };
    const transaction = {
      id: "lifecycle-1",
      intent: "restart",
      home: "/tmp/home",
      oldPid: 1,
      launch: { spawnArgv: ["node"], workingDirectory: "/tmp", savedAt: new Date().toISOString() },
      deadlines: { readyToExitAt: 1, oldPidExitAt: 2, restartReadyAt: 3 },
      statePath: "/tmp/lifecycle.json",
    } satisfies LifecycleTransaction;
    const testable = gateway as unknown as {
      chats: Map<string, typeof first | typeof second>;
      beginLifecycle(transaction: LifecycleTransaction): Promise<unknown>;
      enqueueWithContextSerial(
        event: unknown,
        chatId: string,
        threadId: string | null,
        userId: string,
        messageId: string,
        segments: unknown[],
        admit: () => void,
      ): Promise<void>;
      sendLifecycleNotice(kind: string): Promise<unknown>;
      lifecycleState: { kind: string };
    };
    testable.chats.set("first", first);
    testable.chats.set("second", second);
    testable.sendLifecycleNotice = vi.fn(async (kind) => {
      events.push(`notice:${kind}`);
      return [];
    });

    const lifecycle = testable.beginLifecycle(transaction);
    const duplicate = testable.beginLifecycle(transaction);
    expect(duplicate).toBe(lifecycle);
    await expect(
      testable.beginLifecycle({ ...transaction, id: "lifecycle-2", intent: "stop" }),
    ).rejects.toThrow("already active");
    await expect(testable.beginLifecycle({ ...transaction, intent: "stop" })).rejects.toThrow(
      "already active",
    );
    expect(testable.lifecycleState).toMatchObject({
      kind: "quiescing",
      intent: "restart",
      transactionId: "lifecycle-1",
    });
    await testable.enqueueWithContextSerial({}, "chat", "topic", "user", "message", [], () =>
      events.push("admit"),
    );
    expect(notices.at(-1)?.body).toContain("未排队");
    expect(events).toEqual(expect.arrayContaining(["first:start", "second:start"]));
    expect(events).not.toContain("notice:restarting");

    releaseFirst();
    await Promise.resolve();
    expect(events).not.toContain("notice:restarting");
    releaseSecond();
    await expect(lifecycle).resolves.toMatchObject({
      accepted: true,
      transactionId: "lifecycle-1",
      readyToExit: true,
    });
    expect(events.at(-1)).toBe("notice:restarting");
    expect(testable.lifecycleState).toMatchObject({ kind: "readyToExit" });

    const shutdownAllRuntimes = vi.fn(async () => {});
    Object.assign(testable, {
      started: true,
      shutdownAllRuntimes,
      sessionStore: { close: vi.fn(async () => {}) },
      bindingStore: { close: vi.fn(async () => {}) },
    });
    await gateway.stop();
    expect(shutdownAllRuntimes).not.toHaveBeenCalled();
    expect(first.drain).toHaveBeenCalledOnce();
    expect(second.drain).toHaveBeenCalledOnce();
    expect(events.filter((event) => event === "notice:restarting")).toHaveLength(1);
  });

  it("serializes admission per topic while allowing hydration to finish out of order", async () => {
    const gateway = makeGateway();
    let releaseB!: () => void;
    const bHydration = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    const calls: string[] = [];
    const testable = gateway as unknown as {
      enqueueWithContext(
        event: unknown,
        chatId: string,
        threadId: string | null,
        userId: string,
        messageId: string,
        segments: unknown[],
      ): Promise<void>;
      enqueueWithContextSerial: ReturnType<typeof vi.fn>;
    };
    testable.enqueueWithContextSerial = vi.fn(
      async (_event, _chat, _thread, _user, messageId, _segments, admit) => {
        calls.push(`admit:${messageId}`);
        admit();
        if (messageId === "b") await bHydration;
        calls.push(`done:${messageId}`);
      },
    );

    const b = testable.enqueueWithContext({}, "chat", "topic", "user", "b", []);
    const c = testable.enqueueWithContext({}, "chat", "topic", "user", "c", []);
    const other = testable.enqueueWithContext({}, "chat", "other", "user", "x", []);
    await vi.waitFor(() => expect(calls).toEqual(expect.arrayContaining(["done:c", "done:x"])));
    expect(calls.slice(0, 2)).toContain("admit:b");
    expect(calls.indexOf("admit:b")).toBeLessThan(calls.indexOf("admit:c"));
    expect(calls).not.toContain("done:b");
    releaseB();
    await Promise.all([b, c, other]);
  });

  it("continues the same topic after an admission failure and releases the chain", async () => {
    const gateway = makeGateway();
    const calls: string[] = [];
    const testable = gateway as unknown as {
      enqueueWithContext(
        event: unknown,
        chatId: string,
        threadId: string | null,
        userId: string,
        messageId: string,
        segments: unknown[],
      ): Promise<void>;
      enqueueWithContextSerial: ReturnType<typeof vi.fn>;
      promptIngress: Map<string, Promise<void>>;
    };
    testable.enqueueWithContextSerial = vi.fn(
      async (_event, _chat, _thread, _user, messageId, _segments, admit) => {
        calls.push(messageId);
        if (messageId === "bad") throw new Error("admission failed");
        admit();
      },
    );
    const bad = testable
      .enqueueWithContext({}, "chat", "topic", "user", "bad", [])
      .catch(() => undefined);
    const good = testable.enqueueWithContext({}, "chat", "topic", "user", "good", []);
    await Promise.all([bad, good]);
    expect(calls).toEqual(["bad", "good"]);
    expect(testable.promptIngress.size).toBe(0);
  });
});

describe("LarkGateway Cancel card compatibility", () => {
  it("rejects a versioned Cancel action before runtime lookup", () => {
    const gateway = makeGateway();
    const get = vi.fn();
    (gateway as unknown as { chats: { get: typeof get } }).chats = { get };

    dispatchCardAction(gateway, { v: 2, cancel: true, c: "chat", th: "topic" });

    expect(get).not.toHaveBeenCalled();
  });

  it("makes unversioned legacy Cancel actions inert", () => {
    const gateway = makeGateway();
    const cancel = vi.fn(async () => {});
    const get = vi.fn(() => ({ cancel }));
    (gateway as unknown as { chats: { get: typeof get } }).chats = { get };

    dispatchCardAction(gateway, { cancel: true, c: "chat", th: "topic" });

    expect(get).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe("LarkGateway semantic card actions", () => {
  it("routes only the exact v2 Cancel schema to runtime token authority", () => {
    const gateway = makeGateway();
    const consumeCancelAction = vi.fn(() => "accepted" as const);
    const get = vi.fn(() => ({ consumeCancelAction }));
    (gateway as unknown as { chats: { get: typeof get } }).chats = { get };

    dispatchCardAction(gateway, {
      v: 2,
      c: "chat",
      th: "topic",
      cancel: true,
      p: "prompt",
      s: "segment",
      a: "action",
    });

    expect(consumeCancelAction).toHaveBeenCalledExactlyOnceWith({
      promptToken: "prompt",
      segmentToken: "segment",
      actionToken: "action",
    });
    for (const invalid of [
      { v: 3, c: "chat", cancel: true, p: "prompt", s: "segment", a: "action" },
      { v: 2, c: "chat", cancel: true },
      { v: 2, c: "chat", cancel: true, p: "prompt", s: "segment", a: "action", x: 1 },
    ]) {
      dispatchCardAction(gateway, invalid);
    }
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("routes only the exact v2 permission schema to runtime token authority", () => {
    const gateway = makeGateway();
    const consumePermissionAction = vi.fn(() => "accepted" as const);
    const get = vi.fn(() => ({ consumePermissionAction }));
    (gateway as unknown as { chats: { get: typeof get } }).chats = { get };

    dispatchCardAction(gateway, {
      v: 2,
      c: "chat",
      p: "prompt",
      q: "permission",
      r: "request",
      o: "option",
    });

    expect(consumePermissionAction).toHaveBeenCalledExactlyOnceWith({
      promptToken: "prompt",
      permissionToken: "permission",
      requestId: "request",
      optionId: "option",
    });
    for (const invalid of [
      { v: 99, c: "chat", p: "prompt", q: "permission", r: "request", o: "option" },
      { v: 2, c: "chat", r: "request", o: "option" },
      { v: 2, c: "chat", p: "prompt", q: "permission", r: "request", o: "option", n: "old" },
    ]) {
      dispatchCardAction(gateway, invalid);
    }
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("wires production acknowledgement removal as best effort", async () => {
    const gateway = makeGateway();
    const removeMessageReaction = vi.fn(async () => {});
    (gateway as unknown as { http: { removeMessageReaction: typeof removeMessageReaction } }).http =
      {
        removeMessageReaction,
      };
    const acknowledgement = (
      gateway as unknown as {
        acknowledgement: {
          remove(messageId: string, reactionId: string): Promise<boolean>;
        };
      }
    ).acknowledgement;

    await expect(acknowledgement.remove("message", "reaction")).resolves.toBe(true);
    expect(removeMessageReaction).toHaveBeenCalledExactlyOnceWith("message", "reaction");
    removeMessageReaction.mockRejectedValueOnce(new Error("transport"));
    await expect(acknowledgement.remove("message", "reaction-2")).resolves.toBe(false);
    expect(removeMessageReaction).toHaveBeenCalledTimes(2);
  });
});
