import { describe, it, expect, vi } from "vitest";
import { renderHistoryTurn, replaySessionHistory } from "./session-replay.js";
import type { LarkLogger } from "../logger/logger.js";
import type { LarkPresenter } from "../presenter/presenter.js";
import {
  TopicConversationSession,
  type TopicConversationTokenFactory,
} from "../conversation/topic-conversation-session.js";
import type {
  ActionToken,
  PermissionToken,
  RequestId,
  ResponseCardId,
  ResponseId,
  ResponseToken,
  SupplementCardId,
  TurnId,
} from "../conversation/topic-conversation.js";

describe("renderHistoryTurn", () => {
  it("accepts a turn, prepares+activates, applies the agent text, and finishes it complete", async () => {
    const calls: string[] = [];
    const accept = vi.fn().mockImplementation(() => {
      calls.push("accept");
      return { responseId: "r1" };
    });
    const prepare = vi.fn().mockImplementation(async () => {
      calls.push("prepare");
    });
    const activate = vi.fn().mockImplementation(async () => {
      calls.push("activate");
      return "tok";
    });
    const applyAgentUpdate = vi.fn().mockImplementation(async () => {
      calls.push("applyAgentUpdate");
    });
    const finishOwner = vi.fn().mockResolvedValue({ pendingBatch: null, carrierResponseId: null });
    const flushPresentation = vi.fn().mockResolvedValue(undefined);
    const session = {
      accept,
      prepare,
      activate,
      applyAgentUpdate,
      finishOwner,
      flushPresentation,
    } as never;

    await renderHistoryTurn(session, "anchor-1", { userText: "q", agentText: "a" });

    expect(accept).toHaveBeenCalledWith({
      sourceMessageId: "anchor-1",
      content: "q",
      profile: null,
    });
    expect(prepare).toHaveBeenCalledWith("r1", null);
    expect(activate).toHaveBeenCalledWith("r1");
    expect(applyAgentUpdate).toHaveBeenCalledWith("r1", {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "a" },
    });
    // Ownership must be established (prepare→activate) before any agent update.
    expect(calls).toEqual(["accept", "prepare", "activate", "applyAgentUpdate"]);
    expect(finishOwner).toHaveBeenCalledWith("complete");
    expect(flushPresentation).toHaveBeenCalled();
  });

  it("skips applyAgentUpdate when agentText is empty", async () => {
    const accept = vi.fn().mockReturnValue({ responseId: "r1" });
    const prepare = vi.fn().mockResolvedValue(undefined);
    const activate = vi.fn().mockResolvedValue("tok");
    const applyAgentUpdate = vi.fn().mockResolvedValue(undefined);
    const finishOwner = vi.fn().mockResolvedValue({ pendingBatch: null, carrierResponseId: null });
    const flushPresentation = vi.fn().mockResolvedValue(undefined);
    const session = {
      accept,
      prepare,
      activate,
      applyAgentUpdate,
      finishOwner,
      flushPresentation,
    } as never;
    await renderHistoryTurn(session, "anchor-1", { userText: "q", agentText: "" });
    expect(prepare).toHaveBeenCalledWith("r1", null);
    expect(activate).toHaveBeenCalledWith("r1");
    expect(applyAgentUpdate).not.toHaveBeenCalled();
    expect(finishOwner).toHaveBeenCalledWith("complete");
  });
});

describe("replaySessionHistory", () => {
  it("renders one Response per captured turn, fires onHistoryLoaded, kills agent, returns count", async () => {
    const process = { kill: vi.fn(), killed: false, exitCode: null, pid: 1 };
    const agentSentinel = { process };
    const spawn = vi.fn(
      async (opts: { client: { sessionUpdate: (p: unknown) => Promise<void> } }) => {
        await opts.client.sessionUpdate({
          update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "q1" } },
        });
        await opts.client.sessionUpdate({
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "a1" } },
        });
        return agentSentinel;
      },
    );
    const accept = vi.fn().mockReturnValue({ responseId: "r" });
    const session = {
      accept,
      prepare: vi.fn().mockResolvedValue(undefined),
      activate: vi.fn().mockResolvedValue("tok"),
      applyAgentUpdate: vi.fn().mockResolvedValue(undefined),
      finishOwner: vi.fn().mockResolvedValue({ pendingBatch: null, carrierResponseId: null }),
      flushPresentation: vi.fn().mockResolvedValue(undefined),
    } as never;
    const onHistoryLoaded = vi.fn().mockResolvedValue(undefined);

    const result = await replaySessionHistory({
      session,
      anchorMessageId: "anchor",
      sessionId: "sess",
      spawnOptions: { command: "x", args: [], cwd: ".", env: {}, logger: {} as never },
      spawnAndLoad: spawn as never,
      onHistoryLoaded,
    });

    expect(result.turnCount).toBe(1);
    expect(process.kill).toHaveBeenCalled();
    expect(onHistoryLoaded).toHaveBeenCalledWith(1);
    expect(accept).toHaveBeenCalledTimes(1);
  });

  it("kills the loaded agent even when a render throws mid-loop", async () => {
    const process = { kill: vi.fn(), killed: false, exitCode: null, pid: 1 };
    const agentSentinel = { process };
    const spawn = vi.fn(
      async (opts: { client: { sessionUpdate: (p: unknown) => Promise<void> } }) => {
        await opts.client.sessionUpdate({
          update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "q1" } },
        });
        return agentSentinel;
      },
    );
    const session = {
      accept: vi.fn().mockReturnValue({ responseId: "r" }),
      prepare: vi.fn().mockRejectedValue(new Error("render boom")),
      activate: vi.fn().mockResolvedValue("tok"),
      applyAgentUpdate: vi.fn().mockResolvedValue(undefined),
      finishOwner: vi.fn().mockResolvedValue({ pendingBatch: null, carrierResponseId: null }),
      flushPresentation: vi.fn().mockResolvedValue(undefined),
    } as never;

    await expect(
      replaySessionHistory({
        session,
        anchorMessageId: "anchor",
        sessionId: "sess",
        spawnOptions: { command: "x", args: [], cwd: ".", env: {}, logger: {} as never },
        spawnAndLoad: spawn as never,
      }),
    ).rejects.toThrow("render boom");
    expect(process.kill).toHaveBeenCalled();
  });
});

describe("renderHistoryTurn with a real TopicConversationSession", () => {
  const logger: LarkLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
  };

  function sequentialTokens(): TopicConversationTokenFactory {
    const counts = new Map<string, number>();
    const next = (name: string) => {
      const count = (counts.get(name) ?? 0) + 1;
      counts.set(name, count);
      return `${name}-${count}`;
    };
    return {
      turn: () => next("turn") as TurnId,
      request: () => next("request") as RequestId,
      response: () => next("response") as ResponseId,
      responseToken: () => next("response-token") as ResponseToken,
      card: () => next("card") as ResponseCardId,
      supplementCard: () => next("supplement-card") as SupplementCardId,
      action: () => next("action") as ActionToken,
      permission: () => next("permission") as PermissionToken,
      permissionRequest: () => next("permission-request"),
    };
  }

  function realFixture() {
    const sent: unknown[] = [];
    const presenter = {
      sendConversationCard: vi.fn(async (_messageId, view) => {
        sent.push(view);
        return `external-card-${sent.length}`;
      }),
      updateConversationCard: vi.fn(async () => true),
      sendPermissionRequestCard: vi.fn(async () => "permission-card"),
      expirePermissionCard: vi.fn(async () => undefined),
    } as unknown as LarkPresenter;
    const cancel = vi.fn(async () => undefined);
    const session = new TopicConversationSession({
      presenter,
      logger,
      route: { c: "chat", th: "thread" },
      tokens: sequentialTokens(),
      showThoughts: true,
      showTools: true,
      showCancelButton: true,
      permissionTimeoutMs: 0,
      onCancelResponse: cancel,
      onPermissionDisplayFailure: cancel,
    });
    return { session, presenter, sent };
  }

  it("renders a card without throwing and clears executionOwner after the turn", async () => {
    const { session, presenter } = realFixture();

    await expect(
      renderHistoryTurn(session, "anchor-msg-id", { userText: "hi", agentText: "hello world" }),
    ).resolves.toBeUndefined();

    // The full lifecycle sealed the replay turn, so ownership is released.
    expect(session.snapshot.executionOwnerResponseId).toBeNull();

    // A conversation card carrying the agent text was actually produced. The
    // reconciler sends a placeholder card then patches content in, so the agent
    // text can land on either the send or the update call.
    const send = vi.mocked(presenter.sendConversationCard);
    const update = vi.mocked(presenter.updateConversationCard);
    expect(send).toHaveBeenCalled();
    const allViews = [...send.mock.calls.map((c) => c[1]), ...update.mock.calls.map((c) => c[1])];
    const text = JSON.stringify(allViews);
    expect(text).toContain("hello world");
  });

  it("renders two sequential turns without a cross-turn ownership conflict", async () => {
    const { session } = realFixture();
    await renderHistoryTurn(session, "anchor-msg-id", { userText: "q1", agentText: "a1" });
    expect(session.snapshot.executionOwnerResponseId).toBeNull();
    await expect(
      renderHistoryTurn(session, "anchor-msg-id", { userText: "q2", agentText: "a2" }),
    ).resolves.toBeUndefined();
    expect(session.snapshot.executionOwnerResponseId).toBeNull();
  });
});
