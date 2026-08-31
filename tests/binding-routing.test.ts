/**
 * Black-box integration test for per-chat repo routing.
 *
 * Proves the core promise — "one Lark bot, each chat bound to its own repo" —
 * without Lark credentials or a real agent: a fake presenter records the
 * notice cards and the real SettingsBindingStore / FileSessionStore persist to a
 * temp dir.
 *
 * The gateway's inbound entry points (handleMessage / routeMessage) are private
 * and driven by the Lark WebSocket. We reach the command + routing layer
 * through a narrow typed view of those private methods — acceptable in a test
 * (CLAUDE.md §4 allows a documented cast here) and still observes results only
 * through public surface (the binding store and activeChatCount).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type * as Lark from "@larksuiteoapi/node-sdk";
import {
  LarkGateway,
  FileSessionStore,
  SettingsBindingStore,
  type LarkPresenter,
  type NoticeCardSpec,
  type AgentResolver,
  type ResolvedAgentInvocation,
  type SessionRecord,
} from "../src/index.js";
import {
  slashCommandController,
  type SlashCommandInvocation,
} from "../src/interpreter/commands.js";

/** Records every notice card the gateway tries to render. */
class RecordingPresenter implements LarkPresenter {
  readonly notices: NoticeCardSpec[] = [];
  readonly commandResults: NoticeCardSpec[] = [];
  readonly texts: string[] = [];

  async replyText(_messageId: string, text: string): Promise<void> {
    this.texts.push(text);
  }
  async replyImage(): Promise<boolean> {
    return true;
  }
  async sendConversationCard(): Promise<string | null> {
    return null;
  }
  async updateConversationCard(): Promise<boolean> {
    return true;
  }
  async sendPermissionRequestCard(): Promise<string | null> {
    return null;
  }
  async expirePermissionCard(): Promise<void> {}
  async replyNoticeCard(_replyToMessageId: string, notice: NoticeCardSpec): Promise<string | null> {
    this.notices.push(notice);
    return "notice_msg";
  }
  async replyCommandResultCard(_replyToMessageId: string, result: NoticeCardSpec): Promise<void> {
    this.commandResults.push(result);
  }
  async sendNoticeCard(_chatId: string, notice: NoticeCardSpec): Promise<string | null> {
    this.notices.push(notice);
    return "notice_msg";
  }
}

/** Minimal view of the private methods this test drives. */
type TestRuntime = {
  readonly chatId: string;
  readonly threadId: string | null;
  shutdown(reason: "cancelled" | null): Promise<void>;
};

interface GatewayInternals {
  handleMessage(event: Lark.RawMessageEvent): void;
  handleCommand(
    command: SlashCommandInvocation,
    chatId: string,
    threadId: string | null,
    messageId: string,
  ): Promise<void>;
  resolveBinding(
    chatId: string,
    threadId: string | null,
  ): Promise<{ cwd: string; label: string; explicit: boolean } | null>;
  snapshotBindings(): Promise<void>;
  reloadBindings(): Promise<void>;
  persistControlBinding(chatId: string, threadId: string | null, cwd: string): Promise<boolean>;
  controlConfigureSession(
    chatId: string,
    threadId: string | null,
    input: {
      readonly bindingCwd?: string;
      readonly targetAgent?: {
        readonly sessionId: string;
        readonly profileOnly?: boolean;
        readonly agentCommand: string;
        readonly agentArgs: readonly string[];
        readonly agentLabel?: string;
        readonly cwd: string;
      };
    },
  ): Promise<unknown>;
  acquireRuntime(
    chatId: string,
    threadId: string | null,
    binding: { cwd: string; label: string; explicit: boolean },
    recovery?: "recover-on-acquire" | "pending-observed-under-lock",
  ): Promise<unknown>;
  withPendingConfigurationLock<T>(
    chatId: string,
    threadId: string | null,
    fn: () => Promise<T>,
  ): Promise<T>;
  readonly activeChatCount: number;
  readonly chats: Map<string, TestRuntime>;
}

function asInternals(gateway: LarkGateway): GatewayInternals {
  return gateway as unknown as GatewayInternals;
}

async function dispatchCommand(
  gateway: LarkGateway,
  input: string,
  chatId: string,
  messageId: string,
  threadId: string | null = null,
): Promise<void> {
  const invocation = slashCommandController.resolve(input);
  if (invocation === null) throw new Error(`expected slash command: ${input}`);
  await asInternals(gateway).handleCommand(invocation, chatId, threadId, messageId);
}

const resolver: AgentResolver = (selection: string): ResolvedAgentInvocation => {
  if (selection === "claude") {
    return { command: "npx", args: ["-y", "claude-code-acp"], label: "claude" };
  }
  if (selection === "codex") {
    return { command: "npx", args: ["-y", "codex-acp"], label: "codex" };
  }
  const [command, ...args] = selection.trim().split(/\s+/);
  if (!command) throw new Error("empty agent selection");
  return { command, args, label: selection };
};

let dataDir: string;
let settingsPath: string;
let repoA: string;
let repoAlias: string;
let repoB: string;
let repoC: string;
let presenter: RecordingPresenter;
let bindingStore: SettingsBindingStore;
let sessionStore: FileSessionStore;
let gateway: LarkGateway;

function makeGateway(defaults?: {
  defaultAgent?: ResolvedAgentInvocation;
  defaultCwd?: string;
  unboundCwd?: string;
}): LarkGateway {
  return new LarkGateway({
    lark: { appId: "cli_test", appSecret: "secret_test" },
    agent: {
      resolver,
      defaultAgent: defaults?.defaultAgent ?? null,
      defaultCwd: defaults?.defaultCwd ?? null,
      permissionMode: "alwaysAllow",
    },
    sessionStore,
    bindingStore,
    presenter,
    settingsPath,
    ...(defaults?.unboundCwd !== undefined ? { unboundCwd: defaults.unboundCwd } : {}),
  });
}

const TOPIC_RUNTIME_SEPARATOR = String.fromCharCode(0);

function addTestRuntime(
  internals: GatewayInternals,
  chatId: string,
  threadId: string | null,
): TestRuntime["shutdown"] {
  const shutdown = vi.fn(async () => {});
  const key = threadId === null ? chatId : `${chatId}${TOPIC_RUNTIME_SEPARATOR}${threadId}`;
  internals.chats.set(key, { chatId, threadId, shutdown });
  return shutdown;
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolvePromise: (() => void) | null = null;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => {
      if (resolvePromise === null) throw new Error("deferred promise has no resolver");
      resolvePromise();
    },
  };
}

function deferredRejection(reason: unknown): { readonly promise: Promise<void>; reject(): void } {
  let rejectPromise: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<void>((_resolve, reject) => {
    rejectPromise = reject;
  });
  return {
    promise,
    reject: () => rejectPromise?.(reason),
  };
}

function textEvent(
  text: string,
  chatId: string,
  threadId: string | null,
  messageId: string,
): Lark.RawMessageEvent {
  return {
    message: {
      message_id: messageId,
      chat_id: chatId,
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text }),
      ...(threadId ? { thread_id: threadId } : {}),
    },
    sender: {
      sender_type: "user",
      sender_id: { open_id: "ou_user" },
    },
  } as unknown as Lark.RawMessageEvent;
}

function sessionRecord(threadId: string | null, sessionId: string, cwd: string): SessionRecord {
  return {
    chatId: "oc_A",
    threadId,
    sessionId,
    agentCommand: "npx",
    agentArgs: ["-y", "claude-code-acp"],
    cwd,
    createdAt: 1,
    updatedAt: 1,
  };
}

beforeEach(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "humming-e2e-"));
  dataDir = path.join(root, "data");
  settingsPath = path.join(root, "settings.json");
  repoA = path.join(root, "repo-a");
  repoAlias = path.join(root, "repo-alias");
  repoB = path.join(root, "repo-b");
  repoC = path.join(root, "repo-c");
  fs.mkdirSync(repoA, { recursive: true });
  fs.symlinkSync(repoA, repoAlias, "dir");
  fs.mkdirSync(repoB, { recursive: true });
  fs.mkdirSync(repoC, { recursive: true });

  presenter = new RecordingPresenter();
  bindingStore = new SettingsBindingStore(settingsPath);
  sessionStore = new FileSessionStore(dataDir);
  await bindingStore.init();
  await sessionStore.init();
});

afterEach(async () => {
  await bindingStore.close();
  await sessionStore.close();
  fs.rmSync(path.dirname(dataDir), { recursive: true, force: true });
});

describe("per-chat repo routing (integration)", () => {
  it("binds two chats to two different repos, isolated", async () => {
    gateway = makeGateway({
      defaultAgent: { command: "npx", args: ["-y", "claude-code-acp"], label: "claude" },
    });
    const b = asInternals(gateway);

    await dispatchCommand(gateway, `/bind ${repoA}`, "oc_A", "om_1");
    await dispatchCommand(gateway, `/bind ${repoB}`, "oc_B", "om_2");

    expect(await bindingStore.get("oc_A")).toMatchObject({ cwd: repoA });
    expect(await bindingStore.get("oc_B")).toMatchObject({ cwd: repoB });

    // Resolution returns each chat's own repo — no cross-talk. The runtime agent
    // is the global default until a session profile exists for the repo.
    expect(await b.resolveBinding("oc_A", null)).toMatchObject({
      cwd: repoA,
      explicit: true,
      label: "claude",
    });
    expect(await b.resolveBinding("oc_B", null)).toMatchObject({
      cwd: repoB,
      explicit: true,
      label: "claude",
    });

    const bindNotices = presenter.notices.filter((n) => n.title === "✅ 已绑定 repo");
    expect(bindNotices.length).toBe(2);
    expect(bindNotices[0]?.body).toContain("修改明细");
    expect(bindNotices[0]?.body).not.toContain("Agent：");
  });

  it("routes two topics in one chat to their own effective repositories", async () => {
    gateway = makeGateway({
      defaultAgent: { command: "npx", args: ["-y", "claude-code-acp"], label: "claude" },
    });
    const internals = asInternals(gateway);

    await dispatchCommand(gateway, `/bind ${repoA}`, "oc_A", "om_main");
    await dispatchCommand(gateway, `/bind ${repoB}`, "oc_A", "om_topic", "th_B");

    expect(await bindingStore.get("oc_A")).toMatchObject({
      cwd: repoA,
      topics: { th_B: { cwd: repoB } },
    });
    expect(await internals.resolveBinding("oc_A", null)).toMatchObject({ cwd: repoA });
    expect(await internals.resolveBinding("oc_A", "th_B")).toMatchObject({ cwd: repoB });
  });

  it("unbinds one topic override without changing its sibling or chat default", async () => {
    gateway = makeGateway({
      defaultAgent: { command: "npx", args: ["-y", "claude-code-acp"], label: "claude" },
    });
    const internals = asInternals(gateway);

    await dispatchCommand(gateway, `/bind ${repoA}`, "oc_A", "om_main");
    await dispatchCommand(gateway, `/bind ${repoB}`, "oc_A", "om_t1", "th_1");
    await dispatchCommand(gateway, `/bind ${repoC}`, "oc_A", "om_t2", "th_2");
    await dispatchCommand(gateway, "/unbind", "oc_A", "om_t1_unbind", "th_1");

    expect(await bindingStore.get("oc_A")).toMatchObject({
      cwd: repoA,
      topics: { th_2: { cwd: repoC } },
    });
    expect(await internals.resolveBinding("oc_A", "th_1")).toMatchObject({ cwd: repoA });
    expect(await internals.resolveBinding("oc_A", "th_2")).toMatchObject({ cwd: repoC });
  });

  it("changes a chat default without overwriting explicit topic overrides", async () => {
    gateway = makeGateway({
      defaultAgent: { command: "npx", args: ["-y", "claude-code-acp"], label: "claude" },
    });
    const internals = asInternals(gateway);

    await dispatchCommand(gateway, `/bind ${repoA}`, "oc_A", "om_main");
    await dispatchCommand(gateway, `/bind ${repoB}`, "oc_A", "om_topic", "th_1");
    await dispatchCommand(gateway, `/bind --chat ${repoC}`, "oc_A", "om_chat", "th_1");

    expect(await bindingStore.get("oc_A")).toMatchObject({
      cwd: repoC,
      topics: { th_1: { cwd: repoB } },
    });
    expect(await internals.resolveBinding("oc_A", null)).toMatchObject({ cwd: repoC });
    expect(await internals.resolveBinding("oc_A", "th_1")).toMatchObject({ cwd: repoB });
    expect(presenter.notices.at(-1)?.body).toContain(`• Repo：${repoA} → ${repoC}`);
  });

  it("clears only the current topic session and runtime when its effective cwd changes", async () => {
    gateway = makeGateway();
    const internals = asInternals(gateway);
    await bindingStore.set("oc_A", { kind: "chat" }, repoA);
    await Promise.all([
      sessionStore.save(sessionRecord(null, "session_main", repoA)),
      sessionStore.save(sessionRecord("th_current", "session_current", repoA)),
      sessionStore.save(sessionRecord("th_sibling", "session_sibling", repoA)),
    ]);
    const mainShutdown = addTestRuntime(internals, "oc_A", null);
    const currentShutdown = addTestRuntime(internals, "oc_A", "th_current");
    const siblingShutdown = addTestRuntime(internals, "oc_A", "th_sibling");

    await dispatchCommand(gateway, `/bind ${repoB}`, "oc_A", "om_topic", "th_current");

    expect(await sessionStore.getLatest("oc_A", "th_current")).toBeNull();
    expect(await sessionStore.getLatest("oc_A", null)).toMatchObject({ sessionId: "session_main" });
    expect(await sessionStore.getLatest("oc_A", "th_sibling")).toMatchObject({
      sessionId: "session_sibling",
    });
    expect(currentShutdown).toHaveBeenCalledWith("cancelled");
    expect(mainShutdown).not.toHaveBeenCalled();
    expect(siblingShutdown).not.toHaveBeenCalled();
    expect(internals.activeChatCount).toBe(2);
  });

  it("hot-reloads an external topic override without clearing main or sibling scopes", async () => {
    gateway = makeGateway();
    const internals = asInternals(gateway);
    await bindingStore.set("oc_A", { kind: "chat" }, repoA);
    await bindingStore.set("oc_A", { kind: "topic", threadId: "th_current" }, repoB);
    await bindingStore.set("oc_A", { kind: "topic", threadId: "th_sibling" }, repoC);
    await Promise.all([
      sessionStore.save(sessionRecord(null, "session_main", repoA)),
      sessionStore.save(sessionRecord("th_current", "session_current", repoB)),
      sessionStore.save(sessionRecord("th_sibling", "session_sibling", repoC)),
    ]);
    const mainShutdown = addTestRuntime(internals, "oc_A", null);
    const currentShutdown = addTestRuntime(internals, "oc_A", "th_current");
    const siblingShutdown = addTestRuntime(internals, "oc_A", "th_sibling");
    await internals.snapshotBindings();

    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        bindings: {
          oc_A: {
            cwd: repoA,
            topics: {
              th_current: { cwd: repoC },
              th_sibling: { cwd: repoC },
            },
          },
        },
      }),
    );
    await internals.reloadBindings();

    expect(await sessionStore.getLatest("oc_A", "th_current")).toBeNull();
    expect(await sessionStore.getLatest("oc_A", null)).toMatchObject({ sessionId: "session_main" });
    expect(await sessionStore.getLatest("oc_A", "th_sibling")).toMatchObject({
      sessionId: "session_sibling",
    });
    expect(currentShutdown).toHaveBeenCalledWith("cancelled");
    expect(mainShutdown).not.toHaveBeenCalled();
    expect(siblingShutdown).not.toHaveBeenCalled();
    expect(internals.activeChatCount).toBe(2);
  });

  it("retries an external binding reset after a scope shutdown failure", async () => {
    gateway = makeGateway();
    const internals = asInternals(gateway);
    await bindingStore.set("oc_A", { kind: "chat" }, repoA);
    await sessionStore.save(sessionRecord(null, "session_main", repoA));
    const shutdown = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("temporary shutdown failure"))
      .mockResolvedValueOnce();
    internals.chats.set("oc_A", { chatId: "oc_A", threadId: null, shutdown });
    await internals.snapshotBindings();

    fs.writeFileSync(settingsPath, JSON.stringify({ bindings: { oc_A: { cwd: repoB } } }));

    await expect(internals.reloadBindings()).rejects.toThrow("temporary shutdown failure");
    expect(await sessionStore.getLatest("oc_A", null)).toMatchObject({ sessionId: "session_main" });

    await internals.reloadBindings();

    expect(shutdown).toHaveBeenCalledTimes(2);
    expect(await sessionStore.getLatest("oc_A", null)).toBeNull();
  });

  it("commits successful chat reloads while retrying a failed chat on the next reload", async () => {
    gateway = makeGateway();
    const internals = asInternals(gateway);
    await Promise.all([
      bindingStore.set("oc_A", { kind: "chat" }, repoA),
      bindingStore.set("oc_B", { kind: "chat" }, repoA),
      sessionStore.save(sessionRecord(null, "session_a", repoA)),
      sessionStore.save({ ...sessionRecord(null, "session_b", repoA), chatId: "oc_B" }),
    ]);
    const failedShutdown = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("oc_A shutdown failure"))
      .mockResolvedValueOnce();
    const successfulShutdown = addTestRuntime(internals, "oc_B", null);
    internals.chats.set("oc_A", { chatId: "oc_A", threadId: null, shutdown: failedShutdown });
    await internals.snapshotBindings();
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ bindings: { oc_A: { cwd: repoB }, oc_B: { cwd: repoB } } }),
    );

    await expect(internals.reloadBindings()).rejects.toThrow("oc_A shutdown failure");
    expect(successfulShutdown).toHaveBeenCalledWith("cancelled");
    expect(await sessionStore.getLatest("oc_B", null)).toBeNull();
    expect(await sessionStore.getLatest("oc_A", null)).toMatchObject({ sessionId: "session_a" });

    await internals.reloadBindings();

    expect(failedShutdown).toHaveBeenCalledTimes(2);
    expect(successfulShutdown).toHaveBeenCalledTimes(1);
    expect(await sessionStore.getLatest("oc_A", null)).toBeNull();
  });

  it("waits for the existing context queue before resetting an affected scope", async () => {
    gateway = makeGateway();
    const internals = asInternals(gateway);
    await bindingStore.set("oc_A", { kind: "chat" }, repoA);
    await internals.snapshotBindings();
    const releaseContext = deferred();
    const shutdown = addTestRuntime(internals, "oc_A", null);
    const heldContext = internals.withPendingConfigurationLock("oc_A", null, async () => {
      await releaseContext.promise;
    });
    fs.writeFileSync(settingsPath, JSON.stringify({ bindings: { oc_A: { cwd: repoB } } }));

    const reload = internals.reloadBindings();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(shutdown).not.toHaveBeenCalled();
    releaseContext.resolve();
    await Promise.all([heldContext, reload]);

    expect(shutdown).toHaveBeenCalledWith("cancelled");
  });

  it("skips a stale reload after a queued configure applies a newer binding profile", async () => {
    gateway = makeGateway({
      defaultAgent: { command: "npx", args: ["-y", "claude-code-acp"], label: "claude" },
    });
    const internals = asInternals(gateway);
    await bindingStore.set("oc_A", { kind: "chat" }, repoA);
    await internals.snapshotBindings();

    const releaseInitialLock = deferred();
    const initialLock = internals.withPendingConfigurationLock("oc_A", null, async () => {
      await releaseInitialLock.promise;
    });
    fs.writeFileSync(settingsPath, JSON.stringify({ bindings: { oc_A: { cwd: repoB } } }));
    const configured = internals.controlConfigureSession("oc_A", null, {
      bindingCwd: repoC,
      targetAgent: {
        sessionId: "profile:new-c",
        profileOnly: true,
        agentCommand: "npx",
        agentArgs: ["-y", "codex-acp"],
        agentLabel: "codex",
        cwd: repoC,
      },
    });
    const staleReloadBlocked = deferred();
    const releaseStaleReload = deferred();
    const interveningLock = internals.withPendingConfigurationLock("oc_A", null, async () => {
      staleReloadBlocked.resolve();
      await releaseStaleReload.promise;
    });
    const reload = internals.reloadBindings();
    await new Promise<void>((resolve) => setImmediate(resolve));

    releaseInitialLock.resolve();
    await expect(configured).resolves.toMatchObject({ applied: true, agent: "codex" });
    await staleReloadBlocked.promise;
    expect(await bindingStore.get("oc_A")).toMatchObject({ cwd: repoC });
    expect(await sessionStore.getLatest("oc_A", null)).toMatchObject({
      sessionId: "profile:new-c",
      agentLabel: "codex",
      cwd: repoC,
    });
    const bindingC = await internals.resolveBinding("oc_A", null);
    if (bindingC === null) throw new Error("expected configured binding C");
    const runtimeC = await internals.acquireRuntime(
      "oc_A",
      null,
      bindingC,
      "pending-observed-under-lock",
    );

    releaseStaleReload.resolve();
    await Promise.all([initialLock, interveningLock, reload]);

    expect(await bindingStore.get("oc_A")).toMatchObject({ cwd: repoC });
    expect(await sessionStore.getLatest("oc_A", null)).toMatchObject({
      sessionId: "profile:new-c",
      agentLabel: "codex",
      cwd: repoC,
    });
    expect(internals.chats.get("oc_A")).toBe(runtimeC);
    expect(await internals.resolveBinding("oc_A", null)).toMatchObject({ cwd: repoC });
  });

  it("skips a stale reload when a queued configure applies the same target binding", async () => {
    gateway = makeGateway({
      defaultAgent: { command: "npx", args: ["-y", "claude-code-acp"], label: "claude" },
    });
    const internals = asInternals(gateway);
    await bindingStore.set("oc_A", { kind: "chat" }, repoA);
    await internals.snapshotBindings();

    const releaseInitialLock = deferred();
    const initialLock = internals.withPendingConfigurationLock("oc_A", null, async () => {
      await releaseInitialLock.promise;
    });
    fs.writeFileSync(settingsPath, JSON.stringify({ bindings: { oc_A: { cwd: repoB } } }));
    const configured = internals.controlConfigureSession("oc_A", null, {
      bindingCwd: repoB,
      targetAgent: {
        sessionId: "profile:new-b",
        profileOnly: true,
        agentCommand: "npx",
        agentArgs: ["-y", "codex-acp"],
        agentLabel: "codex",
        cwd: repoB,
      },
    });
    const staleReloadBlocked = deferred();
    const releaseStaleReload = deferred();
    const interveningLock = internals.withPendingConfigurationLock("oc_A", null, async () => {
      staleReloadBlocked.resolve();
      await releaseStaleReload.promise;
    });
    const reload = internals.reloadBindings();
    await new Promise<void>((resolve) => setImmediate(resolve));

    releaseInitialLock.resolve();
    await expect(configured).resolves.toMatchObject({ applied: true, agent: "codex" });
    await staleReloadBlocked.promise;
    expect(await bindingStore.get("oc_A")).toMatchObject({ cwd: repoB });
    expect(await sessionStore.getLatest("oc_A", null)).toMatchObject({
      sessionId: "profile:new-b",
      agentLabel: "codex",
      cwd: repoB,
    });
    const bindingB = await internals.resolveBinding("oc_A", null);
    if (bindingB === null) throw new Error("expected configured binding B");
    const runtimeB = await internals.acquireRuntime(
      "oc_A",
      null,
      bindingB,
      "pending-observed-under-lock",
    );

    releaseStaleReload.resolve();
    await Promise.all([initialLock, interveningLock, reload]);

    expect(await bindingStore.get("oc_A")).toMatchObject({ cwd: repoB });
    expect(await sessionStore.getLatest("oc_A", null)).toMatchObject({
      sessionId: "profile:new-b",
      agentLabel: "codex",
      cwd: repoB,
    });
    expect(internals.chats.get("oc_A")).toBe(runtimeB);
  });

  it("keeps the plan version while reload expands targets asynchronously", async () => {
    gateway = makeGateway({
      defaultAgent: { command: "npx", args: ["-y", "claude-code-acp"], label: "claude" },
    });
    const internals = asInternals(gateway);
    await bindingStore.set("oc_A", { kind: "chat" }, repoA);
    await internals.snapshotBindings();
    fs.writeFileSync(settingsPath, JSON.stringify({ bindings: { oc_A: { cwd: repoB } } }));

    const targetExpansionStarted = deferred();
    const releaseTargetExpansion = deferred();
    const originalListByChat = sessionStore.listByChat.bind(sessionStore);
    let listByChatCalls = 0;
    const listByChat = vi.spyOn(sessionStore, "listByChat").mockImplementation(async (chatId) => {
      listByChatCalls += 1;
      if (listByChatCalls === 1) {
        targetExpansionStarted.resolve();
        await releaseTargetExpansion.promise;
      }
      return originalListByChat(chatId);
    });

    const reload = internals.reloadBindings();
    await targetExpansionStarted.promise;
    await expect(
      internals.controlConfigureSession("oc_A", null, {
        bindingCwd: repoB,
        targetAgent: {
          sessionId: "profile:planned-b",
          profileOnly: true,
          agentCommand: "npx",
          agentArgs: ["-y", "codex-acp"],
          agentLabel: "codex",
          cwd: repoB,
        },
      }),
    ).resolves.toMatchObject({ applied: true, agent: "codex" });
    const bindingB = await internals.resolveBinding("oc_A", null);
    if (bindingB === null) throw new Error("expected configured binding B");
    const runtimeB = await internals.acquireRuntime(
      "oc_A",
      null,
      bindingB,
      "pending-observed-under-lock",
    );

    releaseTargetExpansion.resolve();
    await reload;
    listByChat.mockRestore();

    expect(await sessionStore.getLatest("oc_A", null)).toMatchObject({
      sessionId: "profile:planned-b",
      agentLabel: "codex",
      cwd: repoB,
    });
    expect(internals.chats.get("oc_A")).toBe(runtimeB);
  });

  it("ignores a pinned session from the previous offline binding on first acquire", async () => {
    await bindingStore.set("oc_A", { kind: "chat" }, repoA);
    await sessionStore.save({
      ...sessionRecord("th_offline", "session_old_a", repoA),
      agentArgs: ["-y", "codex-acp"],
      agentLabel: "codex",
    });
    await bindingStore.set("oc_A", { kind: "chat" }, repoB);

    gateway = makeGateway({
      defaultAgent: { command: "npx", args: ["-y", "claude-code-acp"], label: "claude" },
    });
    await gateway.start();
    const internals = asInternals(gateway);
    const binding = await internals.resolveBinding("oc_A", "th_offline");
    if (binding === null) throw new Error("expected offline rebound binding");

    const runtime = (await internals.acquireRuntime(
      "oc_A",
      "th_offline",
      binding,
      "pending-observed-under-lock",
    )) as {
      readonly opts: {
        readonly agentCwd: string;
        readonly agentLabel?: string;
      };
    };

    expect(runtime.opts).toMatchObject({ agentCwd: repoB, agentLabel: "claude" });
    expect(await sessionStore.getLatest("oc_A", "th_offline")).toBeNull();
  });

  it("does not register an old-cwd runtime when an acquisition resumes after reload", async () => {
    gateway = makeGateway({
      defaultAgent: { command: "npx", args: ["-y", "claude-code-acp"], label: "claude" },
    });
    const internals = asInternals(gateway);
    await bindingStore.set("oc_A", { kind: "chat" }, repoA);
    await internals.snapshotBindings();
    const oldBinding = await internals.resolveBinding("oc_A", null);
    if (oldBinding === null) throw new Error("expected initial binding");
    const releaseProfileRead = deferred();
    const originalGetLatest = sessionStore.getLatest.bind(sessionStore);
    const getLatest = vi
      .spyOn(sessionStore, "getLatest")
      .mockImplementation(async (chatId, threadId) => {
        if (chatId === "oc_A" && threadId === null) await releaseProfileRead.promise;
        return originalGetLatest(chatId, threadId);
      });

    const acquisition = internals.acquireRuntime(
      "oc_A",
      null,
      oldBinding,
      "pending-observed-under-lock",
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    fs.writeFileSync(settingsPath, JSON.stringify({ bindings: { oc_A: { cwd: repoB } } }));
    await internals.reloadBindings();
    releaseProfileRead.resolve();
    const runtime = (await acquisition) as { readonly opts: { readonly agentCwd: string } };
    getLatest.mockRestore();

    expect(runtime.opts.agentCwd).toBe(repoB);
    expect(internals.chats.get("oc_A")).toBe(runtime);
  });

  it("invalidates an acquisition that started before the reset barrier was installed", async () => {
    gateway = makeGateway({
      defaultAgent: { command: "npx", args: ["-y", "claude-code-acp"], label: "claude" },
    });
    const internals = asInternals(gateway);
    await bindingStore.set("oc_A", { kind: "chat" }, repoA);
    await sessionStore.save(sessionRecord(null, "session_main", repoA));
    await internals.snapshotBindings();
    const oldBinding = await internals.resolveBinding("oc_A", null);
    if (oldBinding === null) throw new Error("expected initial binding");

    const profileReadStarted = deferred();
    const releaseProfileRead = deferred();
    const originalGetLatest = sessionStore.getLatest.bind(sessionStore);
    const getLatest = vi
      .spyOn(sessionStore, "getLatest")
      .mockImplementation(async (chatId, threadId) => {
        if (chatId === "oc_A" && threadId === null) {
          profileReadStarted.resolve();
          await releaseProfileRead.promise;
        }
        return originalGetLatest(chatId, threadId);
      });
    let acquisitionSettled = false;
    const acquisition = internals
      .acquireRuntime("oc_A", null, oldBinding, "pending-observed-under-lock")
      .finally(() => {
        acquisitionSettled = true;
      });
    await profileReadStarted.promise;

    const clearingStarted = deferred();
    const releaseClear = deferred();
    const originalDelete = sessionStore.delete.bind(sessionStore);
    const deleteSession = vi
      .spyOn(sessionStore, "delete")
      .mockImplementation(async (chatId, sessionId) => {
        clearingStarted.resolve();
        await releaseClear.promise;
        return originalDelete(chatId, sessionId);
      });
    fs.writeFileSync(settingsPath, JSON.stringify({ bindings: { oc_A: { cwd: repoB } } }));
    const reload = internals.reloadBindings();
    await clearingStarted.promise;

    releaseProfileRead.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const runtimeBeforeClear = internals.chats.get("oc_A");
    const settledBeforeClear = acquisitionSettled;
    releaseClear.resolve();
    const runtime = (await acquisition) as { readonly opts: { readonly agentCwd: string } };
    await reload;
    getLatest.mockRestore();
    deleteSession.mockRestore();

    expect(runtimeBeforeClear).toBeUndefined();
    expect(settledBeforeClear).toBe(false);
    expect(runtime.opts.agentCwd).toBe(repoB);
    expect(internals.chats.get("oc_A")).toBe(runtime);
  });

  it("does not register an old-cwd runtime during a reset's session-clear window", async () => {
    gateway = makeGateway({
      defaultAgent: { command: "npx", args: ["-y", "claude-code-acp"], label: "claude" },
    });
    const internals = asInternals(gateway);
    await bindingStore.set("oc_A", { kind: "chat" }, repoA);
    await sessionStore.save(sessionRecord(null, "session_main", repoA));
    await internals.snapshotBindings();
    const oldBinding = await internals.resolveBinding("oc_A", null);
    if (oldBinding === null) throw new Error("expected initial binding");
    addTestRuntime(internals, "oc_A", null);
    const clearingStarted = deferred();
    const releaseClear = deferred();
    const originalDelete = sessionStore.delete.bind(sessionStore);
    const deleteSession = vi
      .spyOn(sessionStore, "delete")
      .mockImplementation(async (chatId, sessionId) => {
        clearingStarted.resolve();
        await releaseClear.promise;
        return originalDelete(chatId, sessionId);
      });
    fs.writeFileSync(settingsPath, JSON.stringify({ bindings: { oc_A: { cwd: repoB } } }));

    const reload = internals.reloadBindings();
    await clearingStarted.promise;
    const acquisition = internals.acquireRuntime(
      "oc_A",
      null,
      oldBinding,
      "pending-observed-under-lock",
    );
    releaseClear.resolve();
    const runtime = (await acquisition) as { readonly opts: { readonly agentCwd: string } };
    await reload;
    deleteSession.mockRestore();

    expect(runtime.opts.agentCwd).toBe(repoB);
    expect(internals.chats.get("oc_A")).toBe(runtime);
  });

  it("rejects an acquisition waiting on a reset whose session clear fails", async () => {
    gateway = makeGateway({
      defaultAgent: { command: "npx", args: ["-y", "claude-code-acp"], label: "claude" },
    });
    const internals = asInternals(gateway);
    await bindingStore.set("oc_A", { kind: "chat" }, repoA);
    await sessionStore.save(sessionRecord(null, "session_main", repoA));
    await internals.snapshotBindings();
    const oldBinding = await internals.resolveBinding("oc_A", null);
    if (oldBinding === null) throw new Error("expected initial binding");
    addTestRuntime(internals, "oc_A", null);
    const clearingStarted = deferred();
    const clearFailure = new Error("session delete failure");
    const rejectClear = deferredRejection(clearFailure);
    const originalDelete = sessionStore.delete.bind(sessionStore);
    const deleteSession = vi
      .spyOn(sessionStore, "delete")
      .mockImplementation(async (chatId, sessionId) => {
        clearingStarted.resolve();
        await rejectClear.promise;
        return originalDelete(chatId, sessionId);
      });
    fs.writeFileSync(settingsPath, JSON.stringify({ bindings: { oc_A: { cwd: repoB } } }));

    const reload = internals.reloadBindings();
    await clearingStarted.promise;
    const acquisition = internals.acquireRuntime(
      "oc_A",
      null,
      oldBinding,
      "pending-observed-under-lock",
    );
    const acquisitionFailure = expect(acquisition).rejects.toThrow(clearFailure);
    const reloadFailure = expect(reload).rejects.toThrow(clearFailure);
    rejectClear.reject();
    await Promise.all([acquisitionFailure, reloadFailure]);
    deleteSession.mockRestore();

    expect(internals.chats.get("oc_A")).toBeUndefined();
  });

  it("rejects a later acquisition after its scope reset has failed", async () => {
    gateway = makeGateway({
      defaultAgent: { command: "npx", args: ["-y", "claude-code-acp"], label: "claude" },
    });
    const internals = asInternals(gateway);
    await bindingStore.set("oc_A", { kind: "chat" }, repoA);
    await sessionStore.save(sessionRecord(null, "session_main", repoA));
    await internals.snapshotBindings();
    const oldBinding = await internals.resolveBinding("oc_A", null);
    if (oldBinding === null) throw new Error("expected initial binding");
    addTestRuntime(internals, "oc_A", null);
    const clearFailure = new Error("session delete failure");
    const deleteSession = vi.spyOn(sessionStore, "delete").mockRejectedValue(clearFailure);
    fs.writeFileSync(settingsPath, JSON.stringify({ bindings: { oc_A: { cwd: repoB } } }));

    await expect(internals.reloadBindings()).rejects.toThrow(clearFailure);
    await expect(
      internals.acquireRuntime("oc_A", null, oldBinding, "pending-observed-under-lock"),
    ).rejects.toThrow(clearFailure);
    deleteSession.mockRestore();

    expect(internals.chats.get("oc_A")).toBeUndefined();
  });

  it("clears a failed reset gate after a successful retry", async () => {
    gateway = makeGateway({
      defaultAgent: { command: "npx", args: ["-y", "claude-code-acp"], label: "claude" },
    });
    const internals = asInternals(gateway);
    await bindingStore.set("oc_A", { kind: "chat" }, repoA);
    await sessionStore.save(sessionRecord(null, "session_main", repoA));
    await internals.snapshotBindings();
    addTestRuntime(internals, "oc_A", null);
    const clearFailure = new Error("session delete failure");
    const originalDelete = sessionStore.delete.bind(sessionStore);
    let shouldFailDelete = true;
    const deleteSession = vi
      .spyOn(sessionStore, "delete")
      .mockImplementation(async (chatId, sessionId) => {
        if (shouldFailDelete) throw clearFailure;
        return originalDelete(chatId, sessionId);
      });
    fs.writeFileSync(settingsPath, JSON.stringify({ bindings: { oc_A: { cwd: repoB } } }));

    await expect(internals.reloadBindings()).rejects.toThrow(clearFailure);
    shouldFailDelete = false;
    await internals.reloadBindings();
    const newBinding = await internals.resolveBinding("oc_A", null);
    if (newBinding === null) throw new Error("expected retried binding");
    const runtime = (await internals.acquireRuntime(
      "oc_A",
      null,
      newBinding,
      "pending-observed-under-lock",
    )) as { readonly opts: { readonly agentCwd: string } };
    deleteSession.mockRestore();

    expect(runtime.opts.agentCwd).toBe(repoB);
    expect(internals.chats.get("oc_A")).toBe(runtime);
  });

  it("holds only the main control scope while child resets wait for their own lock", async () => {
    gateway = makeGateway();
    const internals = asInternals(gateway);
    await bindingStore.set("oc_A", { kind: "chat" }, repoA);
    await sessionStore.save(sessionRecord("th_child", "session_child", repoA));
    await internals.snapshotBindings();
    const childShutdown = addTestRuntime(internals, "oc_A", "th_child");
    const releaseChildLock = deferred();
    const childLock = internals.withPendingConfigurationLock("oc_A", "th_child", async () => {
      await releaseChildLock.promise;
    });

    const configured = internals.withPendingConfigurationLock("oc_A", null, () =>
      internals.persistControlBinding("oc_A", null, repoB),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(childShutdown).not.toHaveBeenCalled();
    releaseChildLock.resolve();
    await Promise.all([configured, childLock]);

    expect(childShutdown).toHaveBeenCalledWith("cancelled");
  });

  it("drains every reset scope before reporting a sibling failure", async () => {
    gateway = makeGateway();
    const internals = asInternals(gateway);
    await bindingStore.set("oc_A", { kind: "chat" }, repoA);
    await bindingStore.set("oc_A", { kind: "topic", threadId: "th_B" }, repoA);
    await internals.snapshotBindings();
    const releaseSibling = deferred();
    internals.chats.set("oc_A", {
      chatId: "oc_A",
      threadId: null,
      shutdown: async () => {
        throw new Error("main reset failure");
      },
    });
    internals.chats.set(`oc_A${TOPIC_RUNTIME_SEPARATOR}th_B`, {
      chatId: "oc_A",
      threadId: "th_B",
      shutdown: async () => {
        await releaseSibling.promise;
      },
    });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ bindings: { oc_A: { cwd: repoB, topics: { th_B: { cwd: repoB } } } } }),
    );

    const reload = internals.reloadBindings();
    let settled = false;
    void reload.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    releaseSibling.resolve();
    await expect(reload).rejects.toThrow("main reset failure");
  });

  it("retries only the failed scope after a same-chat partial reset", async () => {
    gateway = makeGateway();
    const internals = asInternals(gateway);
    await bindingStore.set("oc_A", { kind: "chat" }, repoA);
    await bindingStore.set("oc_A", { kind: "topic", threadId: "th_B" }, repoA);
    await internals.snapshotBindings();
    const mainShutdown = vi.fn(async () => {});
    const topicShutdown = vi.fn(async () => {
      throw new Error("topic reset failure");
    });
    internals.chats.set("oc_A", { chatId: "oc_A", threadId: null, shutdown: mainShutdown });
    internals.chats.set(`oc_A${TOPIC_RUNTIME_SEPARATOR}th_B`, {
      chatId: "oc_A",
      threadId: "th_B",
      shutdown: topicShutdown,
    });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ bindings: { oc_A: { cwd: repoB, topics: { th_B: { cwd: repoB } } } } }),
    );

    await expect(internals.reloadBindings()).rejects.toThrow("topic reset failure");
    topicShutdown.mockResolvedValue(undefined);
    await internals.reloadBindings();

    expect(mainShutdown).toHaveBeenCalledTimes(1);
    expect(topicShutdown).toHaveBeenCalledTimes(2);
  });

  it("retries a failed internal bind reset from the unchanged settings snapshot", async () => {
    gateway = makeGateway({
      defaultAgent: { command: "npx", args: ["-y", "claude-code-acp"], label: "claude" },
    });
    const internals = asInternals(gateway);
    await bindingStore.set("oc_A", { kind: "chat" }, repoA);
    await sessionStore.save(sessionRecord(null, "session_main", repoA));
    await internals.snapshotBindings();
    const shutdown = vi.fn(async () => {
      throw new Error("bind reset failure");
    });
    internals.chats.set("oc_A", { chatId: "oc_A", threadId: null, shutdown });

    await expect(dispatchCommand(gateway, `/bind ${repoB}`, "oc_A", "om_bind")).rejects.toThrow(
      "bind reset failure",
    );
    shutdown.mockResolvedValue(undefined);
    await internals.reloadBindings();
    const binding = await internals.resolveBinding("oc_A", null);
    if (binding === null) throw new Error("expected rebound binding");
    const runtime = (await internals.acquireRuntime(
      "oc_A",
      null,
      binding,
      "pending-observed-under-lock",
    )) as { readonly opts: { readonly agentCwd: string } };

    expect(runtime.opts.agentCwd).toBe(repoB);
  });

  it("keeps a replacement runtime registered when reload finishes an older teardown", async () => {
    gateway = makeGateway();
    const internals = asInternals(gateway);
    await bindingStore.set("oc_A", { kind: "chat" }, repoA);
    await sessionStore.save(sessionRecord(null, "session_main", repoA));
    await internals.snapshotBindings();
    const shutdownStarted = deferred();
    const releaseShutdown = deferred();
    const oldRuntime: TestRuntime = {
      chatId: "oc_A",
      threadId: null,
      shutdown: async () => {
        shutdownStarted.resolve();
        await releaseShutdown.promise;
      },
    };
    const replacementRuntime: TestRuntime = {
      chatId: "oc_A",
      threadId: null,
      shutdown: async () => {},
    };
    internals.chats.set("oc_A", oldRuntime);
    fs.writeFileSync(settingsPath, JSON.stringify({ bindings: { oc_A: { cwd: repoB } } }));

    const reload = internals.reloadBindings();
    await shutdownStarted.promise;
    internals.chats.set("oc_A", replacementRuntime);
    releaseShutdown.resolve();
    await reload;

    expect(internals.chats.get("oc_A")).toBe(replacementRuntime);
    expect(await sessionStore.getLatest("oc_A", null)).toBeNull();
  });

  it("serializes consecutive reloads before replacing the binding snapshot", async () => {
    gateway = makeGateway();
    const internals = asInternals(gateway);
    await bindingStore.set("oc_A", { kind: "chat" }, repoA);
    await sessionStore.save(sessionRecord(null, "session_main", repoA));
    await internals.snapshotBindings();
    const shutdownStarted = deferred();
    const releaseShutdown = deferred();
    let shutdownCalls = 0;
    internals.chats.set("oc_A", {
      chatId: "oc_A",
      threadId: null,
      shutdown: async () => {
        shutdownCalls += 1;
        shutdownStarted.resolve();
        await releaseShutdown.promise;
      },
    });
    fs.writeFileSync(settingsPath, JSON.stringify({ bindings: { oc_A: { cwd: repoB } } }));

    const firstReload = internals.reloadBindings();
    await shutdownStarted.promise;
    fs.writeFileSync(settingsPath, JSON.stringify({ bindings: { oc_A: { cwd: repoC } } }));
    const secondReload = internals.reloadBindings();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(shutdownCalls).toBe(1);
    releaseShutdown.resolve();
    await Promise.all([firstReload, secondReload]);
    const replacementShutdown = vi.fn(async () => {});
    internals.chats.set("oc_A", {
      chatId: "oc_A",
      threadId: null,
      shutdown: replacementShutdown,
    });
    await sessionStore.save(sessionRecord(null, "session_replacement", repoC));

    await internals.reloadBindings();

    expect(shutdownCalls).toBe(1);
    expect(replacementShutdown).not.toHaveBeenCalled();
    expect(await sessionStore.getLatest("oc_A", null)).toMatchObject({
      sessionId: "session_replacement",
    });
    expect(await bindingStore.get("oc_A")).toMatchObject({ cwd: repoC });
  });

  it("waits for an in-flight reload before stop closes the session store", async () => {
    gateway = makeGateway();
    await bindingStore.set("oc_A", { kind: "chat" }, repoA);
    await gateway.start();
    const internals = asInternals(gateway);
    await sessionStore.save(sessionRecord(null, "session_main", repoA));
    const shutdownStarted = deferred();
    const releaseShutdown = deferred();
    let shutdownCalls = 0;
    internals.chats.set("oc_A", {
      chatId: "oc_A",
      threadId: null,
      shutdown: async () => {
        shutdownCalls += 1;
        if (shutdownCalls !== 1) return;
        shutdownStarted.resolve();
        await releaseShutdown.promise;
      },
    });
    fs.writeFileSync(settingsPath, JSON.stringify({ bindings: { oc_A: { cwd: repoB } } }));

    const reload = internals.reloadBindings();
    await shutdownStarted.promise;
    const close = vi.spyOn(sessionStore, "close");
    const stopping = gateway.stop();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const closesBeforeReloadSettles = close.mock.calls.length;
    releaseShutdown.resolve();
    await Promise.all([reload, stopping]);

    expect(closesBeforeReloadSettles).toBe(0);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("rejects message ingress while stop waits for an in-flight reload", async () => {
    gateway = makeGateway({
      defaultAgent: { command: "npx", args: ["-y", "claude-code-acp"], label: "claude" },
      defaultCwd: repoA,
    });
    await bindingStore.set("oc_A", { kind: "chat" }, repoA);
    await gateway.start();
    const internals = asInternals(gateway);
    await sessionStore.save(sessionRecord(null, "session_main", repoA));
    const clearingStarted = deferred();
    const releaseClear = deferred();
    const originalDelete = sessionStore.delete.bind(sessionStore);
    const deleteSession = vi
      .spyOn(sessionStore, "delete")
      .mockImplementation(async (chatId, sessionId) => {
        clearingStarted.resolve();
        await releaseClear.promise;
        return originalDelete(chatId, sessionId);
      });
    fs.writeFileSync(settingsPath, JSON.stringify({ bindings: { oc_A: { cwd: repoB } } }));
    const reload = internals.reloadBindings();
    await clearingStarted.promise;

    const stopping = gateway.stop();
    const acquire = vi
      .spyOn(internals, "acquireRuntime")
      .mockImplementation(() => new Promise(() => {}));
    internals.handleMessage(textEvent("hello during stop", "oc_new", null, "om_during_stop"));
    for (let turn = 0; turn < 5; turn += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const acquireCallsDuringStop = acquire.mock.calls.length;
    const leakedRuntime = internals.chats.get("oc_new");

    releaseClear.resolve();
    await Promise.all([reload, stopping]);
    acquire.mockRestore();
    deleteSession.mockRestore();

    expect(acquireCallsDuringStop).toBe(0);
    expect(leakedRuntime).toBeUndefined();
  });

  it("hot-reloads a topic-only chat entry without clearing its unbound main scope", async () => {
    gateway = makeGateway({ defaultCwd: repoA });
    const internals = asInternals(gateway);
    await bindingStore.set("oc_A", { kind: "topic", threadId: "th_current" }, repoB);
    await Promise.all([
      sessionStore.save(sessionRecord(null, "session_main", repoA)),
      sessionStore.save(sessionRecord("th_current", "session_current", repoB)),
    ]);
    const mainShutdown = addTestRuntime(internals, "oc_A", null);
    const currentShutdown = addTestRuntime(internals, "oc_A", "th_current");
    await internals.snapshotBindings();

    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ bindings: { oc_A: { topics: { th_current: { cwd: repoC } } } } }),
    );
    await internals.reloadBindings();

    expect(await sessionStore.getLatest("oc_A", null)).toMatchObject({ sessionId: "session_main" });
    expect(await sessionStore.getLatest("oc_A", "th_current")).toBeNull();
    expect(mainShutdown).not.toHaveBeenCalled();
    expect(currentShutdown).toHaveBeenCalledWith("cancelled");
    expect(internals.activeChatCount).toBe(1);
  });

  it("hot-reloads a chat default change without clearing explicit topic siblings", async () => {
    gateway = makeGateway();
    const internals = asInternals(gateway);
    await bindingStore.set("oc_A", { kind: "chat" }, repoA);
    await bindingStore.set("oc_A", { kind: "topic", threadId: "th_override" }, repoC);
    await Promise.all([
      sessionStore.save(sessionRecord(null, "session_main", repoA)),
      sessionStore.save(sessionRecord("th_inheriting", "session_inheriting", repoA)),
      sessionStore.save(sessionRecord("th_override", "session_override", repoC)),
    ]);
    const mainShutdown = addTestRuntime(internals, "oc_A", null);
    const inheritingShutdown = addTestRuntime(internals, "oc_A", "th_inheriting");
    const overrideShutdown = addTestRuntime(internals, "oc_A", "th_override");
    await internals.snapshotBindings();

    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        bindings: { oc_A: { cwd: repoB, topics: { th_override: { cwd: repoC } } } },
      }),
    );
    await internals.reloadBindings();

    expect(await sessionStore.getLatest("oc_A", null)).toBeNull();
    expect(await sessionStore.getLatest("oc_A", "th_inheriting")).toBeNull();
    expect(await sessionStore.getLatest("oc_A", "th_override")).toMatchObject({
      sessionId: "session_override",
    });
    expect(mainShutdown).toHaveBeenCalledWith("cancelled");
    expect(inheritingShutdown).toHaveBeenCalledWith("cancelled");
    expect(overrideShutdown).not.toHaveBeenCalled();
    expect(internals.activeChatCount).toBe(1);
  });

  it("keeps a topic runtime when an external override falls back to the same repository", async () => {
    gateway = makeGateway();
    const internals = asInternals(gateway);
    await bindingStore.set("oc_A", { kind: "chat" }, repoA);
    await bindingStore.set("oc_A", { kind: "topic", threadId: "th_alias" }, repoAlias);
    await sessionStore.save(sessionRecord("th_alias", "session_alias", repoA));
    const shutdown = addTestRuntime(internals, "oc_A", "th_alias");
    await internals.snapshotBindings();

    fs.writeFileSync(settingsPath, JSON.stringify({ bindings: { oc_A: { cwd: repoA } } }));
    await internals.reloadBindings();

    expect(await sessionStore.getLatest("oc_A", "th_alias")).toMatchObject({
      sessionId: "session_alias",
    });
    expect(shutdown).not.toHaveBeenCalled();
    expect(internals.activeChatCount).toBe(1);
  });

  it("clears main and inheriting topics when the chat default changes", async () => {
    gateway = makeGateway();
    const internals = asInternals(gateway);
    await bindingStore.set("oc_A", { kind: "chat" }, repoA);
    await bindingStore.set("oc_A", { kind: "topic", threadId: "th_override" }, repoC);
    await Promise.all([
      sessionStore.save(sessionRecord(null, "session_main", repoA)),
      sessionStore.save(sessionRecord("th_inheriting", "session_inheriting", repoA)),
      sessionStore.save(sessionRecord("th_override", "session_override", repoC)),
    ]);
    const mainShutdown = addTestRuntime(internals, "oc_A", null);
    const inheritingShutdown = addTestRuntime(internals, "oc_A", "th_inheriting");
    const overrideShutdown = addTestRuntime(internals, "oc_A", "th_override");

    await dispatchCommand(gateway, `/bind --chat ${repoB}`, "oc_A", "om_chat", "th_inheriting");

    expect(await sessionStore.getLatest("oc_A", null)).toBeNull();
    expect(await sessionStore.getLatest("oc_A", "th_inheriting")).toBeNull();
    expect(await sessionStore.getLatest("oc_A", "th_override")).toMatchObject({
      sessionId: "session_override",
    });
    expect(mainShutdown).toHaveBeenCalledWith("cancelled");
    expect(inheritingShutdown).toHaveBeenCalledWith("cancelled");
    expect(overrideShutdown).not.toHaveBeenCalled();
    expect(internals.activeChatCount).toBe(1);
  });

  it("preserves the existing session and runtime for a symlink to the same repository", async () => {
    gateway = makeGateway();
    const internals = asInternals(gateway);
    await bindingStore.set("oc_A", { kind: "chat" }, repoA);
    await sessionStore.save(sessionRecord(null, "session_main", repoA));
    const shutdown = addTestRuntime(internals, "oc_A", null);

    await dispatchCommand(gateway, `/bind ${repoAlias}`, "oc_A", "om_same");

    expect(await sessionStore.getLatest("oc_A", null)).toMatchObject({ sessionId: "session_main" });
    expect(shutdown).not.toHaveBeenCalled();
    expect(internals.activeChatCount).toBe(1);
    expect(presenter.notices.at(-1)?.body).toContain("绑定已更新，后续消息会继续使用当前 Agent。");
    expect(presenter.notices.at(-1)?.body).not.toContain("启动 Agent");
  });

  it("inherits a profile across symlink aliases of the same repository", async () => {
    gateway = makeGateway({
      defaultAgent: { command: "npx", args: ["-y", "claude-code-acp"], label: "claude" },
    });
    const internals = asInternals(gateway);
    await bindingStore.set("oc_A", { kind: "chat" }, repoAlias);
    await sessionStore.save({
      ...sessionRecord("th_profile", "session_alias_profile", repoAlias),
      agentArgs: ["-y", "codex-acp"],
      agentLabel: "codex",
      controls: { modeId: "agent", gatewayPermissionMode: "alwaysAsk" },
      updatedAt: 10,
    });
    const shutdown = addTestRuntime(internals, "oc_A", "th_profile");

    await dispatchCommand(gateway, `/bind --chat ${repoA}`, "oc_A", "om_canonical", "th_profile");
    expect(shutdown).not.toHaveBeenCalled();
    expect(await sessionStore.getLatest("oc_A", "th_profile")).toMatchObject({
      sessionId: "session_alias_profile",
    });

    const binding = await internals.resolveBinding("oc_A", "th_new");
    if (binding === null) throw new Error("expected canonical binding");
    const runtime = (await internals.acquireRuntime(
      "oc_A",
      "th_new",
      binding,
      "pending-observed-under-lock",
    )) as {
      readonly opts: {
        readonly agentCwd: string;
        readonly agentLabel?: string;
        readonly inheritedControls?: unknown;
      };
    };

    expect(runtime.opts).toMatchObject({ agentCwd: repoAlias, agentLabel: "codex" });
    expect(runtime.opts.inheritedControls).toMatchObject({
      modeId: "agent",
      gatewayPermissionMode: "alwaysAsk",
    });
  });

  it("clears a session and runtime when bind cannot canonicalize the old cwd", async () => {
    gateway = makeGateway();
    const internals = asInternals(gateway);
    await bindingStore.set("oc_A", { kind: "chat" }, repoA);
    await sessionStore.save(sessionRecord(null, "session_inaccessible", repoA));
    const shutdown = addTestRuntime(internals, "oc_A", null);
    const realpathSync = fs.realpathSync;
    const inaccessible = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const realpath = vi.spyOn(fs, "realpathSync").mockImplementation((cwd, options) => {
      if (cwd === repoA) throw inaccessible;
      return realpathSync(cwd, options);
    });

    try {
      await dispatchCommand(gateway, `/bind ${repoB}`, "oc_A", "om_inaccessible_bind");
    } finally {
      realpath.mockRestore();
    }

    expect(await bindingStore.get("oc_A")).toMatchObject({ cwd: repoB });
    expect(await sessionStore.getLatest("oc_A", null)).toBeNull();
    expect(shutdown).toHaveBeenCalledWith("cancelled");
  });

  it("clears a session and runtime when unbind cannot canonicalize the old cwd", async () => {
    gateway = makeGateway();
    const internals = asInternals(gateway);
    await bindingStore.set("oc_A", { kind: "chat" }, repoB);
    await bindingStore.set("oc_A", { kind: "topic", threadId: "th_inaccessible" }, repoA);
    await sessionStore.save(sessionRecord("th_inaccessible", "session_inaccessible", repoA));
    const shutdown = addTestRuntime(internals, "oc_A", "th_inaccessible");
    const realpathSync = fs.realpathSync;
    const inaccessible = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const realpath = vi.spyOn(fs, "realpathSync").mockImplementation((cwd, options) => {
      if (cwd === repoA) throw inaccessible;
      return realpathSync(cwd, options);
    });

    try {
      await dispatchCommand(
        gateway,
        "/unbind",
        "oc_A",
        "om_inaccessible_unbind",
        "th_inaccessible",
      );
    } finally {
      realpath.mockRestore();
    }

    expect(await bindingStore.get("oc_A")).toMatchObject({ cwd: repoB });
    expect(await sessionStore.getLatest("oc_A", "th_inaccessible")).toBeNull();
    expect(shutdown).toHaveBeenCalledWith("cancelled");
  });

  it("uses a neutral unbind notice when inheriting the same physical repository", async () => {
    gateway = makeGateway();
    const internals = asInternals(gateway);
    await bindingStore.set("oc_A", { kind: "chat" }, repoA);
    await bindingStore.set("oc_A", { kind: "topic", threadId: "th_alias" }, repoAlias);
    await sessionStore.save(sessionRecord("th_alias", "session_alias", repoA));
    const shutdown = addTestRuntime(internals, "oc_A", "th_alias");

    await dispatchCommand(gateway, "/unbind", "oc_A", "om_unbind", "th_alias");

    expect(await sessionStore.getLatest("oc_A", "th_alias")).toMatchObject({
      sessionId: "session_alias",
    });
    expect(shutdown).not.toHaveBeenCalled();
    expect(presenter.notices.at(-1)?.body).toContain("绑定已更新，后续消息会继续使用当前 Agent。");
    expect(presenter.notices.at(-1)?.body).not.toContain("agent 进程已停止");
  });

  it("/new clears only the current topic session and preserves chat/topic bindings", async () => {
    gateway = makeGateway();
    const internals = asInternals(gateway);
    await bindingStore.set("oc_A", { kind: "chat" }, repoA);
    await bindingStore.set("oc_A", { kind: "topic", threadId: "th_current" }, repoB);
    await bindingStore.set("oc_A", { kind: "topic", threadId: "th_sibling" }, repoC);
    await Promise.all([
      sessionStore.save(sessionRecord(null, "session_main", repoA)),
      sessionStore.save(sessionRecord("th_current", "session_current", repoB)),
      sessionStore.save(sessionRecord("th_sibling", "session_sibling", repoC)),
    ]);
    const mainShutdown = addTestRuntime(internals, "oc_A", null);
    const currentShutdown = addTestRuntime(internals, "oc_A", "th_current");
    const siblingShutdown = addTestRuntime(internals, "oc_A", "th_sibling");

    await dispatchCommand(gateway, "/new", "oc_A", "om_new", "th_current");

    expect(await bindingStore.get("oc_A")).toMatchObject({
      cwd: repoA,
      topics: { th_current: { cwd: repoB }, th_sibling: { cwd: repoC } },
    });
    expect(await sessionStore.getLatest("oc_A", "th_current")).toBeNull();
    expect(await sessionStore.getLatest("oc_A", null)).toMatchObject({ sessionId: "session_main" });
    expect(await sessionStore.getLatest("oc_A", "th_sibling")).toMatchObject({
      sessionId: "session_sibling",
    });
    expect(currentShutdown).toHaveBeenCalledWith("cancelled");
    expect(mainShutdown).not.toHaveBeenCalled();
    expect(siblingShutdown).not.toHaveBeenCalled();
  });

  it("persists bindings across a gateway/process restart", async () => {
    gateway = makeGateway();
    await dispatchCommand(gateway, `/bind ${repoA}`, "oc_A", "om_1");
    await bindingStore.close();

    const store2 = new SettingsBindingStore(settingsPath);
    await store2.init();
    const restored = await store2.get("oc_A");
    expect(restored).toMatchObject({ cwd: repoA });
    expect(restored).not.toHaveProperty("agentLabel");
    await store2.close();
  });

  it("rejects /bind to a non-existent directory (no binding written)", async () => {
    gateway = makeGateway();
    await dispatchCommand(gateway, `/bind ${path.join(repoA, "does-not-exist")}`, "oc_A", "om_1");
    expect(await bindingStore.get("oc_A")).toBeNull();
    expect(presenter.notices.some((n) => n.title === "⚠️ 绑定失败")).toBe(true);
  });

  it("unbound chat with no default resolves to null (gateway asks for /bind)", async () => {
    gateway = makeGateway();
    expect(await asInternals(gateway).resolveBinding("oc_new", null)).toBeNull();
  });

  it("falls back to the configured default when a chat has no explicit bind", async () => {
    gateway = makeGateway({
      defaultAgent: { command: "npx", args: ["-y", "claude-code-acp"], label: "claude" },
      defaultCwd: repoA,
    });
    const resolved = await asInternals(gateway).resolveBinding("oc_unbound", null);
    expect(resolved).toMatchObject({ cwd: repoA, explicit: false, label: "claude" });
  });

  it("/unbind removes the binding", async () => {
    gateway = makeGateway();
    await dispatchCommand(gateway, `/bind ${repoA}`, "oc_A", "om_1");
    expect(await bindingStore.get("oc_A")).not.toBeNull();

    await dispatchCommand(gateway, "/unbind", "oc_A", "om_2");
    expect(await bindingStore.get("oc_A")).toBeNull();
  });

  it("reports the effective binding source for topic, chat, default, and reception", async () => {
    gateway = makeGateway({
      defaultAgent: { command: "npx", args: ["-y", "claude-code-acp"], label: "claude" },
    });
    await bindingStore.set("oc_A", { kind: "chat" }, repoA);
    await bindingStore.set("oc_A", { kind: "topic", threadId: "th_topic" }, repoB);

    await dispatchCommand(gateway, "/where", "oc_A", "om_topic", "th_topic");
    expect(presenter.notices.at(-1)?.body).toContain("来源：topic");
    await dispatchCommand(gateway, "/where", "oc_A", "om_chat");
    expect(presenter.notices.at(-1)?.body).toContain("来源：chat");

    gateway = makeGateway({
      defaultAgent: { command: "npx", args: ["-y", "claude-code-acp"], label: "claude" },
      defaultCwd: repoA,
    });
    await dispatchCommand(gateway, "/where", "oc_default", "om_default");
    expect(presenter.notices.at(-1)?.body).toContain("来源：default");

    gateway = makeGateway({
      defaultAgent: { command: "npx", args: ["-y", "claude-code-acp"], label: "claude" },
      unboundCwd: repoC,
    });
    await dispatchCommand(gateway, "/where", "oc_reception", "om_reception");
    expect(presenter.notices.at(-1)?.body).toContain("来源：reception");
  });

  it("rebinds an unavailable topic to reception without changing chat or sibling bindings", async () => {
    gateway = makeGateway({
      defaultAgent: { command: "npx", args: ["-y", "claude-code-acp"], label: "claude" },
      unboundCwd: repoC,
    });
    const internals = asInternals(gateway);
    await bindingStore.set("oc_A", { kind: "chat" }, repoA);
    await bindingStore.set("oc_A", { kind: "topic", threadId: "th_deleted" }, repoB);
    await bindingStore.set("oc_A", { kind: "topic", threadId: "th_sibling" }, repoC);
    fs.rmSync(repoB, { recursive: true, force: true });

    const fallback = await internals.resolveBinding("oc_A", "th_deleted");

    expect(fallback).toMatchObject({ cwd: repoC, source: "reception", reception: true });
    expect(await bindingStore.get("oc_A")).toMatchObject({
      cwd: repoA,
      topics: { th_deleted: { cwd: repoC }, th_sibling: { cwd: repoC } },
    });
    expect(await internals.resolveBinding("oc_A", "th_sibling")).toMatchObject({ cwd: repoC });
  });

  it("rebinding a chat overwrites only its repo", async () => {
    gateway = makeGateway();
    await dispatchCommand(gateway, `/bind ${repoA}`, "oc_A", "om_1");
    await dispatchCommand(gateway, `/bind ${repoB}`, "oc_A", "om_2");

    expect(await bindingStore.get("oc_A")).toMatchObject({ cwd: repoB });
    expect((await bindingStore.list()).length).toBe(1);
  });
});
