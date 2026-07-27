import { describe, it, expect } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import { foldReplayHistory } from "./replay-history-reducer.js";

function u(update: acp.SessionUpdate): acp.SessionUpdate {
  return update;
}

describe("foldReplayHistory", () => {
  it("pairs a user message with the following agent message text", () => {
    const updates: acp.SessionUpdate[] = [
      u({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "hello" } }),
      u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi there" } }),
    ];
    expect(foldReplayHistory(updates)).toEqual([{ userText: "hello", agentText: "hi there" }]);
  });
});
