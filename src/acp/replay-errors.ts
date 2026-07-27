/** Thrown when replay is requested but the Agent lacks ACP `session/load`. */
export class AgentReplayUnsupportedError extends Error {
  constructor(readonly sessionId: string) {
    super(
      `agent does not support ACP loadSession; history replay unavailable for session ${sessionId}`,
    );
    this.name = "AgentReplayUnsupportedError";
  }
}
