import type * as acp from "@agentclientprotocol/sdk";
import type { AgentProcess, SpawnAgentOptions } from "../acp/agent-process.js";
import { killAgent, spawnAndLoadAgent as defaultSpawnAndLoad } from "../acp/agent-process.js";
import { foldReplayHistory, type HistoryTurn } from "../acp/replay-history-reducer.js";
import type { TopicConversationSession } from "../conversation/topic-conversation-session.js";

type RenderableSession = Pick<
  TopicConversationSession,
  "accept" | "prepare" | "activate" | "applyAgentUpdate" | "finishOwner" | "flushPresentation"
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
  await session.prepare(accepted.responseId, null);
  await session.activate(accepted.responseId);
  if (turn.agentText.length > 0) {
    await session.applyAgentUpdate(accepted.responseId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: turn.agentText },
    });
  }
  await session.finishOwner("complete");
  await session.flushPresentation();
}

export interface ReplaySessionInput {
  readonly session: RenderableSession;
  readonly anchorMessageId: string;
  readonly sessionId: string;
  readonly spawnOptions: Omit<SpawnAgentOptions, "client">;
  readonly onHistoryLoaded?: (turnCount: number) => Promise<void>;
  /** Injected for tests; defaults to the real force-load spawn. */
  readonly spawnAndLoad?: (opts: SpawnAgentOptions, sessionId: string) => Promise<AgentProcess>;
}

export interface ReplaySessionResult {
  readonly turnCount: number;
}

/**
 * Force-load `sessionId`, capture the streamed history, and render each turn as
 * its own Response into the current thread. The loaded agent process is always
 * killed once rendering finishes or fails — the engine owns its lifecycle.
 *
 * @throws {AgentReplayUnsupportedError} when the agent lacks loadSession.
 * @throws {Error} when spawning/initializing fails or the load itself rejects.
 */
export async function replaySessionHistory(
  input: ReplaySessionInput,
): Promise<ReplaySessionResult> {
  const captured: acp.SessionUpdate[] = [];
  const client: acp.Client = {
    // A force-load only streams `session/update` notifications. The load path
    // never asks the client to touch the filesystem or authorize a tool call,
    // so mirror ListingClient's idle/no-op handling: capture updates, reject
    // any stray permission request as cancelled.
    async requestPermission(): Promise<acp.RequestPermissionResponse> {
      return { outcome: { outcome: "cancelled" } };
    },
    async sessionUpdate(params: acp.SessionNotification): Promise<void> {
      captured.push(params.update);
    },
  };
  const spawn = input.spawnAndLoad ?? defaultSpawnAndLoad;
  const agent = await spawn({ ...input.spawnOptions, client }, input.sessionId);
  try {
    const turns = foldReplayHistory(captured);
    await input.onHistoryLoaded?.(turns.length);
    for (const turn of turns) {
      await renderHistoryTurn(input.session, input.anchorMessageId, turn);
    }
    return { turnCount: turns.length };
  } finally {
    killAgent(agent.process);
  }
}
