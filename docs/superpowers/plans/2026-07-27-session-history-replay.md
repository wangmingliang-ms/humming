# Session History Replay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replay an existing ACP session's history (user inputs + agent final text) into the current Feishu topic thread, triggered by `/replay` (slash command), `session bind --replay` (CLI), or the natural-language mapping "绑定 Session 并且重放历史".

**Architecture:** A pure reducer folds the `session/update` stream produced by ACP `session/load` into `HistoryTurn[]` (`{userText, agentText}`), keeping only user messages and agent message text. A replay engine forces the load path (bypassing resume priority), captures those turns, and renders each turn as its own Response through the existing `TopicConversationSession` card pipeline — so short turns become one card and long turns overflow into multiple cards under the existing budget. Three entry points share this engine.

**Tech Stack:** TypeScript (strict, NodeNext), Vitest, Commander/Zod CLI, `@agentclientprotocol/sdk`, existing conversation/render pipeline.

---

## File Structure

**New files:**
- `src/acp/replay-history-reducer.ts` — pure `sessionUpdate[] → HistoryTurn[]` fold + `HistoryTurn` type.
- `src/acp/replay-history-reducer.test.ts` — unit tests for the reducer.
- `src/acp/replay-errors.ts` — `AgentReplayUnsupportedError`.
- `src/gateway/session-replay.ts` — `replaySessionHistory(...)` engine: spawn+force-load, capture stream via reducer, render each turn.
- `src/gateway/session-replay.test.ts` — unit test for the render-injection helper (turn → conversation calls).

**Modified files:**
- `src/acp/agent-process.ts` — add `spawnAndLoadAgent(...)` (force-load spawn variant) + export a `captureLoadHistory` hook so the load stream is collected.
- `src/acp/index.ts` — re-export new symbols.
- `src/interpreter/commands.ts` — add `{kind:"replay"}` command, `SlashCommandContext.replay()`, register `/replay`.
- `src/interpreter/commands.test.ts` — parse tests for `/replay`.
- `src/gateway/gateway.ts` — wire `replay` into `createSlashCommandContext`, add `handleReplayCommand`, add `replaySession` control handler.
- `src/gateway/control-server.ts` — add `replaySession` to control interface + dispatch.
- `bin/cli/commands/session.ts` — add `--replay` flag to `bind`, pass through control call.
- `CLAUDE.md` + `~/.humming/AGENTS.md` — document `/replay`, `bind --replay`, NL mapping.

---

## Task 1: History reducer type + skeleton

**Files:**
- Create: `src/acp/replay-history-reducer.ts`
- Test: `src/acp/replay-history-reducer.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/acp/replay-history-reducer.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/acp/replay-history-reducer.test.ts`
Expected: FAIL — "foldReplayHistory is not a function".

- [ ] **Step 3: Write minimal implementation**

```ts
// src/acp/replay-history-reducer.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/acp/replay-history-reducer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/acp/replay-history-reducer.ts src/acp/replay-history-reducer.test.ts
git commit -m "feat(acp): fold session/load stream into replayable history turns"
```

---

## Task 2: Reducer edge cases (concatenation, skip thought/tool, empty)

**Files:**
- Modify: `src/acp/replay-history-reducer.test.ts`

- [ ] **Step 1: Add failing tests**

```ts
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
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run src/acp/replay-history-reducer.test.ts`
Expected: PASS (implementation from Task 1 already covers these; if any fail, fix `replay-history-reducer.ts`).

- [ ] **Step 3: Commit**

```bash
git add src/acp/replay-history-reducer.test.ts
git commit -m "test(acp): cover replay reducer concatenation, skipping, multi-turn"
```

---

## Task 3: Replay-unsupported error type

**Files:**
- Create: `src/acp/replay-errors.ts`
- Test: `src/acp/replay-errors.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/acp/replay-errors.test.ts
import { describe, it, expect } from "vitest";
import { AgentReplayUnsupportedError } from "./replay-errors.js";

describe("AgentReplayUnsupportedError", () => {
  it("carries the sessionId and a descriptive message", () => {
    const err = new AgentReplayUnsupportedError("sess-1");
    expect(err).toBeInstanceOf(Error);
    expect(err.sessionId).toBe("sess-1");
    expect(err.message).toContain("loadSession");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/acp/replay-errors.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write implementation**

```ts
// src/acp/replay-errors.ts
/** Thrown when replay is requested but the Agent lacks ACP `session/load`. */
export class AgentReplayUnsupportedError extends Error {
  constructor(readonly sessionId: string) {
    super(
      `agent does not support ACP loadSession; history replay unavailable for session ${sessionId}`,
    );
    this.name = "AgentReplayUnsupportedError";
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/acp/replay-errors.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/acp/replay-errors.ts src/acp/replay-errors.test.ts
git commit -m "feat(acp): add AgentReplayUnsupportedError"
```

---

## Task 4: Force-load spawn variant that captures history

**Files:**
- Modify: `src/acp/agent-process.ts`
- Test: `src/acp/agent-process.replay.test.ts` (create)

**Context:** `spawnAndResumeAgent`/`spawnAndStrictlyResumeAgent` prefer `unstable_resumeSession` when both resume and load exist, and resume does not stream history. Replay needs a variant that (a) requires `loadSession`, else throws `AgentReplayUnsupportedError`, and (b) collects every `session/update` the load emits.

The load emits updates through the `client` passed to `spawnAndInit`. We pass a capturing client that appends non-metadata updates to an array.

- [ ] **Step 1: Write the failing test**

```ts
// src/acp/agent-process.replay.test.ts
import { describe, it, expect, vi } from "vitest";
import { AgentReplayUnsupportedError } from "./replay-errors.js";
import { spawnAndLoadAgent } from "./agent-process.js";

// A fake that drives spawnAndLoadAgent's capability guard without a real process.
// We only assert the guard here; full load streaming is covered by manual E2E.
describe("spawnAndLoadAgent", () => {
  it("throws AgentReplayUnsupportedError when the agent lacks loadSession", async () => {
    await expect(
      spawnAndLoadAgent(
        {
          command: "false",
          args: [],
          cwd: process.cwd(),
          env: {},
          client: { readTextFile: vi.fn(), writeTextFile: vi.fn(), requestPermission: vi.fn(), sessionUpdate: vi.fn() } as never,
          logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }), info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as never,
        },
        "sess-x",
      ),
    ).rejects.toBeInstanceOf(Error);
  });
});
```

> NOTE: `command: "false"` makes spawn/init fail, so this test asserts the function is wired and rejects. Precise `AgentReplayUnsupportedError` behavior for a live agent lacking load is covered by the E2E task. Keep this as a smoke test.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/acp/agent-process.replay.test.ts`
Expected: FAIL — `spawnAndLoadAgent` not exported.

- [ ] **Step 3: Implement `spawnAndLoadAgent`**

Add to `src/acp/agent-process.ts` (near `spawnAndStrictlyResumeAgent`). Reuse existing `spawnAndInit`, `withAgentRequest`, `DEFAULT_AGENT_SESSION_TIMEOUT_MS`, `capabilitiesFromSessionResponse`, `killAgent`, `formatAgentCommand`.

```ts
import { AgentReplayUnsupportedError } from "./replay-errors.js";

/**
 * Spawn an Agent and force the ACP `session/load` path for `sessionId`, never
 * `unstable_resumeSession`, so the agent streams prior history back as
 * `session/update` notifications. The provided `opts.client.sessionUpdate` sees
 * every streamed update — the caller supplies a capturing client to collect
 * them.
 *
 * @throws {AgentReplayUnsupportedError} when the Agent lacks `loadSession`.
 */
export async function spawnAndLoadAgent(
  opts: SpawnAgentOptions,
  sessionId: string,
): Promise<AgentProcess> {
  const { proc, connection, initResult, getRecentStderr } = await spawnAndInit(opts);
  const agentCaps = initResult.agentCapabilities;
  const capabilities = (agentCaps ?? {}) as Record<string, unknown>;
  if (!agentCaps?.loadSession) {
    killAgent(proc);
    throw new AgentReplayUnsupportedError(sessionId);
  }
  try {
    const loadResult = await withAgentRequest(
      connection.loadSession({ sessionId, cwd: opts.cwd, mcpServers: [] }),
      connection,
      DEFAULT_AGENT_SESSION_TIMEOUT_MS,
      `agent loadSession (${formatAgentCommand(opts.command, opts.args)})`,
    );
    opts.logger.info({ sessionId, mode: "load" }, "session force-loaded for replay");
    return {
      process: proc,
      connection,
      sessionId,
      capabilities,
      sessionCapabilities: capabilitiesFromSessionResponse(loadResult),
      getRecentStderr,
    };
  } catch (err) {
    killAgent(proc);
    throw new Error("Failed to load agent session for replay", { cause: err });
  }
}
```

- [ ] **Step 4: Export from index**

In `src/acp/index.ts` add named re-exports:

```ts
export { spawnAndLoadAgent } from "./agent-process.js";
export { AgentReplayUnsupportedError } from "./replay-errors.js";
export { foldReplayHistory, type HistoryTurn } from "./replay-history-reducer.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/acp/agent-process.replay.test.ts`
Expected: PASS (rejects as expected).

- [ ] **Step 6: Typecheck + commit**

Run: `npx tsc --noEmit`
Expected: no errors.

```bash
git add src/acp/agent-process.ts src/acp/index.ts src/acp/agent-process.replay.test.ts
git commit -m "feat(acp): add spawnAndLoadAgent forcing the load path for replay"
```

---

## Task 5: Render a single history turn through the conversation pipeline

**Files:**
- Create: `src/gateway/session-replay.ts`
- Test: `src/gateway/session-replay.test.ts`

**Context:** Each `HistoryTurn` becomes one Response. We mirror the live-turn lifecycle: `conversation.accept(...)` → `applyAgentUpdate({agent_message_chunk})` → `finishOwner("complete")` → `flushPresentation()`. The synthetic `sourceMessageId` is the anchor Feishu message the replay was triggered from (the `/replay` or bind notice message), so cards reply into the correct thread. The user input renders as the Response's request `content`.

`renderHistoryTurn` takes the `TopicConversationSession` and the anchor id; it must NOT talk to any agent. This makes it unit-testable with a fake session.

- [ ] **Step 1: Write the failing test**

```ts
// src/gateway/session-replay.test.ts
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/gateway/session-replay.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write implementation**

```ts
// src/gateway/session-replay.ts
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
 * overflow into several.
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/gateway/session-replay.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit`
Expected: no errors.

```bash
git add src/gateway/session-replay.ts src/gateway/session-replay.test.ts
git commit -m "feat(gateway): render a single replay history turn as a Response"
```

---

## Task 6: Replay engine — spawn, capture, render all turns

**Files:**
- Modify: `src/gateway/session-replay.ts`
- Modify: `src/gateway/session-replay.test.ts`

**Context:** The engine ties together the capturing client, `spawnAndLoadAgent`, the reducer, and `renderHistoryTurn`. It returns the loaded `AgentProcess` so the caller can keep it as the live runtime (spec §5: the load'd process stays live). It also returns the turn count for the boundary notice.

The capturing client records non-metadata `session/update`s during the load call. Metadata updates (`session_info_update` etc.) are ignored.

- [ ] **Step 1: Add failing test**

```ts
import { replaySessionHistory } from "./session-replay.js";

describe("replaySessionHistory", () => {
  it("renders one Response per captured turn and returns the count", async () => {
    const captured: unknown[] = [];
    const spawn = vi.fn(async (opts: { client: { sessionUpdate: (p: unknown) => Promise<void> } }) => {
      await opts.client.sessionUpdate({ update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "q1" } } });
      await opts.client.sessionUpdate({ update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "a1" } } });
      return { agent: "AGENT" };
    });
    const accept = vi.fn().mockReturnValue({ responseId: "r" });
    const session = {
      accept,
      applyAgentUpdate: vi.fn().mockResolvedValue(undefined),
      finishOwner: vi.fn().mockResolvedValue({ pendingBatch: null, carrierResponseId: null }),
      flushPresentation: vi.fn().mockResolvedValue(undefined),
    } as never;

    const result = await replaySessionHistory({
      session,
      anchorMessageId: "anchor",
      sessionId: "sess",
      spawnOptions: { command: "x", args: [], cwd: ".", env: {}, logger: {} as never },
      spawnAndLoad: spawn as never,
    });

    expect(result.turnCount).toBe(1);
    expect(result.agent).toBe("AGENT");
    expect(accept).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/gateway/session-replay.test.ts`
Expected: FAIL — `replaySessionHistory` not exported.

- [ ] **Step 3: Implement the engine**

Append to `src/gateway/session-replay.ts`:

```ts
import type * as acp from "@agentclientprotocol/sdk";
import type { AgentProcess, SpawnAgentOptions } from "../acp/agent-process.js";
import { spawnAndLoadAgent as defaultSpawnAndLoad } from "../acp/agent-process.js";
import { foldReplayHistory } from "../acp/replay-history-reducer.js";

export interface ReplaySessionInput {
  readonly session: RenderableSession;
  readonly anchorMessageId: string;
  readonly sessionId: string;
  readonly spawnOptions: Omit<SpawnAgentOptions, "client">;
  /** Injected for tests; defaults to the real force-load spawn. */
  readonly spawnAndLoad?: (opts: SpawnAgentOptions, sessionId: string) => Promise<AgentProcess>;
}

export interface ReplaySessionResult {
  readonly agent: AgentProcess;
  readonly turnCount: number;
}

/**
 * Force-load `sessionId`, capture the streamed history, and render each turn as
 * its own Response into the current thread. Returns the loaded agent process so
 * the caller can keep it live.
 *
 * @throws {AgentReplayUnsupportedError} when the agent lacks loadSession.
 */
export async function replaySessionHistory(
  input: ReplaySessionInput,
): Promise<ReplaySessionResult> {
  const captured: acp.SessionUpdate[] = [];
  const client: acp.Client = {
    readTextFile: () => Promise.reject(new Error("not supported during replay load")),
    writeTextFile: () => Promise.reject(new Error("not supported during replay load")),
    requestPermission: () => Promise.resolve({ outcome: { outcome: "cancelled" } }),
    sessionUpdate: async (params: acp.SessionNotification) => {
      captured.push(params.update);
    },
  };
  const spawn = input.spawnAndLoad ?? defaultSpawnAndLoad;
  const agent = await spawn({ ...input.spawnOptions, client }, input.sessionId);
  const turns = foldReplayHistory(captured);
  for (const turn of turns) {
    await renderHistoryTurn(input.session, input.anchorMessageId, turn);
  }
  return { agent, turnCount: turns.length };
}
```

> NOTE: verify `acp.Client`'s exact method set against `src/acp/prompt-callback-router.ts` (it implements `acp.Client`). If `Client` requires more methods, mirror the no-op shape used there.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/gateway/session-replay.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit`
Expected: no errors.

```bash
git add src/gateway/session-replay.ts src/gateway/session-replay.test.ts
git commit -m "feat(gateway): replay engine captures load history and renders turns"
```

---

## Task 7: `/replay` slash command definition

**Files:**
- Modify: `src/interpreter/commands.ts`
- Modify: `src/interpreter/commands.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// add to src/interpreter/commands.test.ts
import { slashCommandController } from "./commands.js";

it("parses /replay as a replay command", () => {
  const resolved = slashCommandController.resolve("/replay");
  expect(resolved?.command).toEqual({ kind: "replay" });
});

it("does not match /replay with trailing args", () => {
  expect(slashCommandController.resolve("/replay now")).toBeNull();
});
```

> If `commands.test.ts` lacks these imports, mirror the existing import style already in that file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/interpreter/commands.test.ts`
Expected: FAIL — resolves to null / wrong kind.

- [ ] **Step 3: Implement the command**

In `src/interpreter/commands.ts`:

1. Extend the `LarkCommand` union (after the `{ kind: "unbind" }` line):

```ts
  | { readonly kind: "replay" }
```

2. Add to `SlashCommandContext`:

```ts
  replay(): Promise<void>;
```

3. Add to the `kind` param union of `defineExactCommand`:

```ts
    readonly kind: "cancel" | "new" | "restart" | "help" | "unbind" | "where" | "replay";
```

4. Define the command (near `newCommand`):

```ts
const replayCommand = defineExactCommand({
  name: "replay",
  tokens: ["/replay"],
  kind: "replay",
  group: "Repo / session",
  help: [
    {
      syntax: "/replay",
      description: "把当前 topic 已绑定 session 的历史（用户输入 + Agent 文本）重放进本 thread",
    },
  ],
  handle: (context) => context.replay(),
});
```

5. Add `replayCommand` to the `SLASH_COMMANDS` array (after `newCommand`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/interpreter/commands.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: FAIL — every `SlashCommandContext` implementer must now provide `replay()`. This is expected; Task 9 wires it in the gateway. If other implementers exist (e.g. tests), add a stub `replay: async () => {}` there.

- [ ] **Step 6: Commit**

```bash
git add src/interpreter/commands.ts src/interpreter/commands.test.ts
git commit -m "feat(interpreter): add /replay slash command"
```

---

## Task 8: `replaySession` gateway control method

**Files:**
- Modify: `src/gateway/control-server.ts`
- Modify: `src/gateway/gateway.ts`

**Context:** `session bind --replay` (Task 10) needs a control entry so the CLI can ask the running gateway to replay. Mirror the existing `bindSession` control wiring at `control-server.ts:138` (interface), request envelope (~87, 427), and dispatch (~307-315).

- [ ] **Step 1: Add to the control interface**

In `src/gateway/control-server.ts`, next to `bindSession(...)`:

```ts
  replaySession(
    chatId: string,
    threadId: string | null,
    sessionId: string,
    noticeMessageId?: string | null,
  ): Promise<unknown>;
```

- [ ] **Step 2: Add the request envelope + dispatch**

Follow the existing `bindSession` pattern in the same file: add `"replaySession"` to the request union/schema (~line 87/427) with params `{ chatId, threadId, sessionId }`, and a `case "replaySession":` dispatch (~307-315) calling `handler.replaySession(params.chatId, params.threadId, params.sessionId, noticeMessageId)`.

> Read the exact `bindSession` envelope block first and copy its shape verbatim, substituting the `replaySession` name and params.

- [ ] **Step 3: Implement the handler in gateway.ts**

In `src/gateway/gateway.ts`, where `bindSession` is registered (~line 950), add:

```ts
      replaySession: (chatId, threadId, sessionId, noticeMessageId) =>
        this.controlReplaySession(chatId, threadId, sessionId, noticeMessageId ?? null),
```

Add the method (near `controlBindSession`, gateway.ts:1612). It resolves the runtime, replays, and posts a notice. See Task 9 for the shared `replayForTopic` helper this and `handleReplayCommand` both call.

```ts
  private async controlReplaySession(
    chatId: string,
    threadId: string | null,
    sessionId: string,
    noticeMessageId: string | null,
  ): Promise<void> {
    await this.replayForTopic(chatId, threadId, sessionId, noticeMessageId);
  }
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: FAIL until `replayForTopic` exists (Task 9). Proceed to Task 9 before committing.

- [ ] **Step 5: Commit (after Task 9 compiles)**

Deferred — commit together with Task 9.

---

## Task 9: `handleReplayCommand` + shared `replayForTopic` helper

**Files:**
- Modify: `src/gateway/gateway.ts`

**Context:** `createSlashCommandContext` (gateway.ts:1804) constructs the context with `chatId, threadId, messageId`. Wire `replay` to `handleReplayCommand`. Both `/replay` and the control path funnel into `replayForTopic`, which: looks up the bound session, sends fail-fast notices, and calls the replay engine against the topic's conversation session.

**Prerequisite reads:** how `controlBindSession` obtains `sessionStore.getLatest`, how it posts notice cards (`replyNoticeCard`/`sendNoticeCard` via the presenter), how a runtime exposes its `TopicConversationSession`, and how `runtime.supersede()` + `this.chats.delete(key)` are used. Match those exact call shapes.

- [ ] **Step 1: Wire the context**

In `createSlashCommandContext` (gateway.ts:1812 area), add:

```ts
      replay: () => this.handleReplayCommand(chatId, threadId, messageId),
```

- [ ] **Step 2: Implement `handleReplayCommand`**

```ts
  private async handleReplayCommand(
    chatId: string,
    threadId: string | null,
    messageId: string,
  ): Promise<void> {
    const latest = this.sessionStore.getLatest(chatId, threadId);
    if (latest === undefined || latest.profileOnly) {
      await this.postTopicNotice(chatId, threadId, messageId, "当前 topic 未绑定 session，无法回放。");
      return;
    }
    await this.replayForTopic(chatId, threadId, latest.sessionId, messageId);
  }
```

> `postTopicNotice` is a thin wrapper over the presenter's notice-card call used elsewhere in gateway.ts. If no such helper exists, inline the same `presenter.replyNoticeCard(...)` call that `controlBindSession` uses for its rejection notice (gateway.ts:1623-1640), reusing its route/anchor arguments.

- [ ] **Step 3: Implement `replayForTopic`**

```ts
  private async replayForTopic(
    chatId: string,
    threadId: string | null,
    sessionId: string,
    anchorMessageId: string | null,
  ): Promise<void> {
    const record = this.sessionStore.getLatest(chatId, threadId);
    if (record === undefined) {
      if (anchorMessageId !== null) {
        await this.postTopicNotice(chatId, threadId, anchorMessageId, "当前 topic 未绑定 session，无法回放。");
      }
      return;
    }
    const anchor = anchorMessageId ?? record.chatId; // anchor must be a real message id; see note
    const runtime = this.ensureRuntime(chatId, threadId); // however gateway obtains/creates a runtime
    try {
      const result = await replaySessionHistory({
        session: runtime.conversationSession, // expose the TopicConversationSession from the runtime
        anchorMessageId: anchor,
        sessionId,
        spawnOptions: {
          command: record.agentCommand,
          args: record.agentArgs,
          cwd: record.cwd,
          env: record.agentEnv,
          logger: this.logger,
        },
      });
      // Keep the loaded agent as the live runtime so conversation continues.
      runtime.adoptLoadedAgent(result.agent); // add a small ChatRuntime method for this
      if (anchorMessageId !== null) {
        await this.postTopicNotice(chatId, threadId, anchorMessageId, `已重放历史（${result.turnCount} 轮）。`);
      }
    } catch (err) {
      if (err instanceof AgentReplayUnsupportedError && anchorMessageId !== null) {
        await this.postTopicNotice(chatId, threadId, anchorMessageId, "该 Agent 不支持历史回放（仅 resume）。");
        return;
      }
      throw err;
    }
  }
```

> **Integration note for the implementer:** the placeholders `ensureRuntime`, `runtime.conversationSession`, `runtime.adoptLoadedAgent`, and `postTopicNotice` must be resolved against the real `ChatRuntime`/gateway API. Read `chat-runtime.ts` (`bootstrap`, `state.agent`, the `TopicConversationSession` field — it's `this.conversation`) and expose:
> - a getter `get conversationSession(): TopicConversationSession` on `ChatRuntime` returning `this.conversation`;
> - a method `adoptLoadedAgent(agent: AgentProcess)` that installs the agent into `state` (mirroring the tail of `bootstrap` at chat-runtime.ts:1031-1097: build `ChatRuntimeState`, attach exit handler, persist session), so the next message uses it.
>
> The boundary notice should be posted BEFORE rendering turns (send "以下为历史回放（N 轮）" first). Reorder so the notice precedes the render loop if product wants the header first; the engine returns `turnCount` after loading, so post the header after `spawnAndLoad` but before the render loop by splitting the engine, OR post a generic "开始回放" header and a "已重放 N 轮" footer. Choose the split-header approach: add an `onHistoryLoaded?(turnCount)` callback to `ReplaySessionInput` and post the header inside it.

- [ ] **Step 4: Add the `onHistoryLoaded` hook to the engine**

In `src/gateway/session-replay.ts`, extend `ReplaySessionInput`:

```ts
  readonly onHistoryLoaded?: (turnCount: number) => Promise<void>;
```

and in `replaySessionHistory`, after `foldReplayHistory` and before the render loop:

```ts
  const turns = foldReplayHistory(captured);
  await input.onHistoryLoaded?.(turns.length);
  for (const turn of turns) { ... }
```

Update `session-replay.test.ts` to assert `onHistoryLoaded` is called with the turn count.

- [ ] **Step 5: Add ChatRuntime getters/methods**

In `src/gateway/chat-runtime.ts` add:

```ts
  get conversationSession(): TopicConversationSession {
    return this.conversation;
  }
```

and implement `adoptLoadedAgent` following the state-construction tail of `bootstrap` (chat-runtime.ts:1031-1097): assign `this.state`, register `agent.process.on("exit", ...)`, `void agent.connection.closed.then(() => router?.connectionShutdown())`, and `await this.persistSession(agent.sessionId)`. Reuse the existing helpers rather than duplicating logic.

> This is the most integration-heavy step. If `adoptLoadedAgent` proves to need the router/client that `bootstrap` builds, prefer instead routing replay THROUGH `bootstrap` with a new `forceLoad` bootstrap mode: pass `mode: "load"` (already supported by `activateBootstrap`, prompt-callback-router.ts:46) and make the bootstrap `sessionUpdate` callback (chat-runtime.ts:993-996) collect message/user chunks into a buffer, then render them after bootstrap completes. Evaluate both at implementation time; the bootstrap-integrated path reuses more existing wiring and is likely cleaner. Update the engine/tests accordingly if you take that path.

- [ ] **Step 6: Typecheck + run gateway tests**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npx vitest run src/gateway/ src/interpreter/`
Expected: PASS.

- [ ] **Step 7: Commit (with Task 8)**

```bash
git add src/gateway/gateway.ts src/gateway/control-server.ts src/gateway/chat-runtime.ts src/gateway/session-replay.ts src/gateway/session-replay.test.ts
git commit -m "feat(gateway): /replay command and replaySession control replay bound session history"
```

---

## Task 10: `session bind --replay` CLI flag

**Files:**
- Modify: `bin/cli/commands/session.ts`
- Test: `bin/cli/commands/session.test.ts` (or the existing session CLI test file)

**Context:** `bind` is defined at session.ts:128-137; `runSessionBind` at ~237-296 calls `callGatewayControl(..., { method: "bindSession", params: { record } })` at line 284. Add `--replay`; after a successful bind, if `--replay`, call the new `replaySession` control. If the gateway isn't running (the fallback branch at ~285-294 writes the store directly), replay is impossible → error.

- [ ] **Step 1: Write the failing test**

```ts
// in the session CLI test file
it("parses --replay on bind", async () => {
  const program = buildSessionProgram(/* existing test harness */);
  const parsed = program.commands.find((c) => c.name() === "bind");
  expect(parsed?.options.some((o) => o.long === "--replay")).toBe(true);
});
```

> Match the existing test harness in the file. If bind options aren't unit-tested there, add a Commander `parseAsync` assertion mirroring the neighbouring tests.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run bin/cli/commands/session.test.ts`
Expected: FAIL — no `--replay` option.

- [ ] **Step 3: Add the flag + type**

In `bin/cli/commands/session.ts`:

```ts
bind.option("--replay", "replay the bound session's history into the current topic");
```

Extend `SessionBindCliOptions` with `replay?: boolean`.

- [ ] **Step 4: Wire replay after bind**

In `runSessionBind`, after the successful `bindSession` control call (line ~284), before returning:

```ts
    if (options.replay) {
      await callGatewayControl(base.homeDir, {
        method: "replaySession",
        params: { chatId: record.chatId, threadId: record.threadId, sessionId: record.sessionId },
      });
    }
```

In the gateway-not-running fallback branch (~285-294), if `options.replay` is set, throw:

```ts
    if (options.replay) {
      throw new Error("历史回放需要 gateway 运行；请先 humming start 后重试。");
    }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run bin/cli/commands/session.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

Run: `npx tsc --noEmit`
Expected: no errors.

```bash
git add bin/cli/commands/session.ts bin/cli/commands/session.test.ts
git commit -m "feat(cli): add session bind --replay to replay history on bind"
```

---

## Task 11: Documentation

**Files:**
- Modify: `CLAUDE.md`
- Modify: `~/.humming/AGENTS.md` (if present; otherwise note it in CLAUDE.md only)

- [ ] **Step 1: Update CLAUDE.md session-operations section**

Add under the session-command guidance (near the `session bind` / `session configure` bullets):

```markdown
- 历史回放：
  - Feishu 内 `/replay`：把当前 topic 已绑定 session 的历史（用户输入 + Agent 最终文本，跳过思考/工具）重放进本 thread。每个历史 turn 独立成卡，长 turn 由卡片预算自动分卡。
  - `humming session bind --session-id <id> --replay`：绑定到已有 session 时顺带回放（需 gateway 运行；Agent 必须支持 loadSession，否则报错且不绑定）。
  - 自然语言映射：用户说“绑定 Session 并且重放历史”时，执行 `humming session bind --session-id <id> --replay`。
```

- [ ] **Step 2: Mirror into ~/.humming/AGENTS.md if it exists**

Run: `test -f ~/.humming/AGENTS.md && echo present || echo absent`
If present, add the same three bullets to its session-operations section.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document /replay, bind --replay, and the NL replay mapping"
```

---

## Task 12: Full verification + manual E2E

- [ ] **Step 1: Full CI triple**

Run: `npx tsc --noEmit && npx eslint . && npx prettier --check . && npm test`
Expected: all pass.

- [ ] **Step 2: Build + restart**

Run: `npm run build && humming restart`
Expected: logs show `WebSocket connected`.

- [ ] **Step 3: Manual E2E — bind --replay happy path**

- Pick a session with multi-turn history in the current repo.
- Run `humming session bind --session-id <id> --replay`.
- Verify in the topic: a "以下为历史回放（N 轮）" header, then each historical turn rendered (user input + agent text), long turns split across cards, thoughts/tools absent.
- Send a new message; verify the agent continues with full context (replay left the session live).

- [ ] **Step 4: Manual E2E — /replay**

- In a topic already bound to a session, type `/replay`.
- Verify the history re-renders. Type `/replay` again; verify it re-renders (no dedup).
- In an unbound topic, type `/replay`; verify the "当前 topic 未绑定 session" notice.

- [ ] **Step 5: Manual E2E — unsupported agent**

- With an agent that supports resume but not load, run `bind --replay`: verify a fail-fast notice AND that the binding did not happen. Run `/replay`: verify the fail-fast notice.

- [ ] **Step 6: Commit any fixes**

```bash
git add -A && git commit -m "fix: address issues found during replay E2E"
```

---

## Notes for the implementer

- **Biggest risk (Task 9):** keeping the load'd agent as the live runtime. Two paths exist: (a) a standalone engine + `adoptLoadedAgent`, or (b) integrating replay INTO `ChatRuntime.bootstrap` with `mode: "load"` (already supported by `activateBootstrap`) and collecting message chunks in the bootstrap `sessionUpdate` callback (chat-runtime.ts:993-996, currently discards them). Path (b) reuses the router/client/persist wiring bootstrap already builds and is likely cleaner — evaluate it first and adapt Tasks 5-6 if you take it (the reducer and `renderHistoryTurn` stay unchanged; only the capture site moves).
- **Anchor message id:** every card needs a real Feishu message id to reply into the thread. Use the triggering `/replay` message id, or the bind notice message id. Never pass a non-message id.
- **`acp.Client` shape:** confirm the exact required methods against `prompt-callback-router.ts` (the canonical `acp.Client` implementer) when building the capturing client.
