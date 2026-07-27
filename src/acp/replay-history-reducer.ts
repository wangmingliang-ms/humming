import type * as acp from "@agentclientprotocol/sdk";

export interface HistoryTurn {
  readonly userText: string;
  readonly agentText: string;
}

/**
 * Fold the `session/update` stream emitted by ACP `session/load` into replayable
 * turns. Keeps only user inputs and agent message text; thoughts and tool calls
 * are dropped. A new turn opens on each user message; consecutive agent message
 * chunks concatenate into that turn's agent text.
 */
export function foldReplayHistory(updates: readonly acp.SessionUpdate[]): readonly HistoryTurn[] {
  const turns: { userText: string; agentText: string }[] = [];
  for (const update of updates) {
    if (update.sessionUpdate === "user_message_chunk") {
      if (update.content.type !== "text") continue;
      turns.push({ userText: update.content.text, agentText: "" });
      continue;
    }
    if (update.sessionUpdate === "agent_message_chunk") {
      if (update.content.type !== "text") continue;
      const current = turns.at(-1);
      if (current === undefined) {
        turns.push({ userText: "", agentText: update.content.text });
        continue;
      }
      current.agentText += update.content.text;
    }
  }
  return turns.map((turn) => ({ userText: turn.userText, agentText: turn.agentText }));
}
