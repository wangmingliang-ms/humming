import { describe, it, expect, vi } from "vitest";
import { renderHistoryTurn } from "./session-replay.js";

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
