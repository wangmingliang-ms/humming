import type { HistoryTurn } from "../acp/replay-history-reducer.js";
import type { TopicConversationSession } from "../conversation/topic-conversation-session.js";

type RenderableSession = Pick<
  TopicConversationSession,
  "accept" | "applyAgentUpdate" | "finishOwner" | "flushPresentation"
>;

/**
 * Render one historical turn as a standalone Response: accept the user input,
 * stream the agent's final text, seal the turn complete, and flush. Card count
 * is delegated to the existing budget — short turns become one card, long turns
 * overflow into several. Never talks to an agent.
 */
export async function renderHistoryTurn(
  session: RenderableSession,
  anchorMessageId: string,
  turn: HistoryTurn,
): Promise<void> {
  const accepted = session.accept({
    sourceMessageId: anchorMessageId,
    content: turn.userText,
    profile: null,
  });
  if (turn.agentText.length > 0) {
    await session.applyAgentUpdate(accepted.responseId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: turn.agentText },
    });
  }
  await session.finishOwner("complete");
  await session.flushPresentation();
}
