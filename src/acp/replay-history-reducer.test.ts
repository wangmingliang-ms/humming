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

  it("concatenates consecutive agent chunks within one turn", () => {
    const updates: acp.SessionUpdate[] = [
      u({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "q" } }),
      u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "part1 " } }),
      u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "part2" } }),
    ];
    expect(foldReplayHistory(updates)).toEqual([{ userText: "q", agentText: "part1 part2" }]);
  });

  it("skips thought and tool_call updates", () => {
    const updates: acp.SessionUpdate[] = [
      u({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "q" } }),
      u({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } }),
      u({ sessionUpdate: "tool_call", toolCallId: "t1", title: "run", status: "pending" } as acp.SessionUpdate),
      u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } }),
    ];
    expect(foldReplayHistory(updates)).toEqual([{ userText: "q", agentText: "answer" }]);
  });

  it("produces multiple turns and handles empty input", () => {
    expect(foldReplayHistory([])).toEqual([]);
    const updates: acp.SessionUpdate[] = [
      u({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "a" } }),
      u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "1" } }),
      u({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "b" } }),
      u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "2" } }),
    ];
    expect(foldReplayHistory(updates)).toEqual([
      { userText: "a", agentText: "1" },
      { userText: "b", agentText: "2" },
    ]);
  });
});
