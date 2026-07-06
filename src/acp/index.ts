export { HummingClient, PERMISSION_MODES } from "./humming-client.js";
export type { HummingClientOptions, PermissionMode } from "./humming-client.js";
export {
  spawnAgent,
  spawnAndResumeAgent,
  listAgentSessions,
  killAgent,
  AgentAuthError,
} from "./agent-process.js";
export type {
  AgentProcess,
  ListedAgentSession,
  ListAgentSessionsOptions,
  ListAgentSessionsResult,
  SpawnAgentOptions,
} from "./agent-process.js";
