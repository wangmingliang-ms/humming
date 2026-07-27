import { describe, it, expect, vi } from "vitest";
import { renderHistoryTurn, replaySessionHistory } from "./session-replay.js";

describe("renderHistoryTurn", () => {
  it("accepts a turn, applies the agent text, and finishes it complete", async () => {
    const accept = vi.fn().mockReturnValue({ responseId: "r1" });
    const applyAgentUpdate = vi.fn().mockResolvedValue(undefined);
    const finishOwner = vi.fn().mockResolvedValue({ pendingBatch: null, carrierResponseId: null });
    const flushPresentation = vi.fn().mockResolvedValue(undefined);
    const session = { accept, applyAgentUpdate, finishOwner, flushPresentation } as never;

    await renderHistoryTurn(session, "anchor-1", { userText: "q", agentText: "a" });

    expect(accept).toHaveBeenCalledWith({
      sourceMessageId: "anchor-1",
      content: "q",
      profile: null,
    });
    expect(applyAgentUpdate).toHaveBeenCalledWith("r1", {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "a" },
    });
    expect(finishOwner).toHaveBeenCalledWith("complete");
    expect(flushPresentation).toHaveBeenCalled();
  });

  it("skips applyAgentUpdate when agentText is empty", async () => {
    const accept = vi.fn().mockReturnValue({ responseId: "r1" });
    const applyAgentUpdate = vi.fn().mockResolvedValue(undefined);
    const finishOwner = vi.fn().mockResolvedValue({ pendingBatch: null, carrierResponseId: null });
    const flushPresentation = vi.fn().mockResolvedValue(undefined);
    const session = { accept, applyAgentUpdate, finishOwner, flushPresentation } as never;
    await renderHistoryTurn(session, "anchor-1", { userText: "q", agentText: "" });
    expect(applyAgentUpdate).not.toHaveBeenCalled();
    expect(finishOwner).toHaveBeenCalledWith("complete");
  });
});

describe("replaySessionHistory", () => {
  it("renders one Response per captured turn, fires onHistoryLoaded, returns count", async () => {
    const agentSentinel = { sessionId: "sess" };
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
    expect(result.agent).toBe(agentSentinel);
    expect(onHistoryLoaded).toHaveBeenCalledWith(1);
    expect(accept).toHaveBeenCalledTimes(1);
  });
});
