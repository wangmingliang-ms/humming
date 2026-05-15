/**
 * Spawn and kill ACP agent subprocesses.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { Writable, Readable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

export interface AgentProcessInfo {
  process: ChildProcess;
  connection: acp.ClientSideConnection;
  sessionId: string;
  capabilities: Record<string, unknown>;
}

export interface SpawnAgentOpts {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  client: acp.Client;
  log: (msg: string) => void;
}

export async function spawnAgent(opts: SpawnAgentOpts): Promise<AgentProcessInfo> {
  const { cwd, log } = opts;
  const { proc, connection, initResult } = await spawnAndInit(opts);

  // Create a new session
  let sessionResult: Awaited<ReturnType<typeof connection.newSession>>;
  try {
    sessionResult = await connection.newSession({ cwd, mcpServers: [] });
  } catch (err) {
    throw new Error(`Failed to create agent session.\n${err instanceof Error ? err.message : err}`);
  }
  log(`Agent initialized, session: ${sessionResult.sessionId}`);

  return {
    process: proc,
    connection,
    sessionId: sessionResult.sessionId,
    capabilities: (initResult.agentCapabilities ?? {}) as Record<string, unknown>,
  };
}

/**
 * Spawn a new agent process and try to resume a previous session.
 * Falls back to creating a new session on the same process if resume isn't supported or fails.
 */
export async function spawnAndResumeAgent(
  opts: SpawnAgentOpts,
  previousSessionId: string,
): Promise<{ agentInfo: AgentProcessInfo; resumed: boolean }> {
  const { cwd, log } = opts;
  const { proc, connection, initResult } = await spawnAndInit(opts);
  const agentCaps = initResult.agentCapabilities;
  const caps = (agentCaps ?? {}) as Record<string, unknown>;

  log(`Agent capabilities: loadSession=${!!agentCaps?.loadSession}, resume=${!!agentCaps?.sessionCapabilities?.resume}`);

  // Try unstable_resumeSession first (lightweight, no history replay)
  const hasResume = !!agentCaps?.sessionCapabilities?.resume;

  // Fall back to loadSession
  const hasLoad = !!agentCaps?.loadSession;

  if (hasResume || hasLoad) {
    try {
      if (hasResume) {
        log(`Resuming session ${previousSessionId} (resume)...`);
        await connection.unstable_resumeSession({ sessionId: previousSessionId });
        log(`Session resumed: ${previousSessionId}`);
      } else {
        log(`Loading session ${previousSessionId} (load)...`);
        await connection.loadSession({ sessionId: previousSessionId, cwd, mcpServers: [] });
        log(`Session loaded: ${previousSessionId}`);
      }

      return {
        agentInfo: { process: proc, connection, sessionId: previousSessionId, capabilities: caps },
        resumed: true,
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : JSON.stringify(err);
      log(`Failed to resume session ${previousSessionId}: ${detail}`);
    }
  } else {
    log(`Agent does not support session resume or load`);
  }

  // Fall back to a new session on the same already-initialized process
  log(`Creating new session on existing agent process`);
  let sessionResult: Awaited<ReturnType<typeof connection.newSession>>;
  try {
    sessionResult = await connection.newSession({ cwd, mcpServers: [] });
  } catch (err) {
    throw new Error(`Failed to create agent session.\n${err instanceof Error ? err.message : err}`);
  }
  log(`Agent initialized, session: ${sessionResult.sessionId}`);

  return {
    agentInfo: { process: proc, connection, sessionId: sessionResult.sessionId, capabilities: caps },
    resumed: false,
  };
}

/** Spawn agent process, initialize protocol, and authenticate. */
async function spawnAndInit(opts: SpawnAgentOpts): Promise<{
  proc: ChildProcess;
  connection: acp.ClientSideConnection;
  initResult: Awaited<ReturnType<acp.ClientSideConnection["initialize"]>>;
}> {
  const { command, args, cwd, env, client, log } = opts;

  log(`Spawning agent: ${command} ${args.join(" ")}`);

  const proc = spawn(command, args, {
    cwd,
    env: { ...process.env, ...(env ?? {}) },
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32",
  });

  proc.stderr?.on("data", (chunk: Buffer) => {
    const line = chunk.toString().trim();
    if (line) log(`[agent stderr] ${line}`);
  });

  const input = Writable.toWeb(proc.stdin!);
  const output = Readable.toWeb(proc.stdout!);
  const stream = acp.ndJsonStream(input, output);

  const connection = new acp.ClientSideConnection(() => client, stream);

  let initResult: Awaited<ReturnType<typeof connection.initialize>>;
  try {
    initResult = await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
      },
    });
  } catch (err) {
    throw new Error(`Failed to initialize agent (${command} ${args.join(" ")}). Is the agent installed?\n${err instanceof Error ? err.message : err}`);
  }

  if (initResult.authMethods && initResult.authMethods.length > 0) {
    const method = initResult.authMethods[0];
    log(`Agent requires authentication (method: ${method.id} / ${method.name}), authenticating...`);
    try {
      await connection.authenticate({ methodId: method.id });
    } catch (err) {
      throw new Error(`Agent authentication failed during setup. Ensure the agent CLI is logged in before starting lark-acp.\n${err instanceof Error ? err.message : err}`);
    }
    log(`Authentication complete`);
  }

  return { proc, connection, initResult };
}

export function killAgent(proc: ChildProcess): void {
  try {
    if (!proc.killed && proc.exitCode === null) proc.kill("SIGTERM");
  } catch {
    // already dead
  }
}
