# Codex ACP Package Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure every newly created built-in Codex session launches the maintained `@agentclientprotocol/codex-acp` package and can process a real prompt.

**Architecture:** Keep Humming's existing dynamic `npx -y` adapter architecture and replace only the built-in Codex preset. Existing persisted sessions and custom/raw invocations remain unchanged; tests enforce the new preset contract, while a real ACP smoke test verifies package launch, session creation, prompt delivery, and response streaming.

**Tech Stack:** TypeScript 5.x, Node.js, Commander, Vitest, Agent Client Protocol SDK, npm/npx, OpenAI Codex ACP adapter.

---

## File Structure

- Modify `bin/humming-agent.test.ts`: exact contract test for the built-in Codex package invocation.
- Modify `bin/agents.ts`: production Codex preset and human-readable adapter description.
- Modify `src/gateway/gateway-agent-switch.test.ts`: current built-in Codex resolver fixture used by gateway tests.
- Modify `README.md`: supported-agent documentation.
- Keep `package.json` and lockfiles unchanged because agent adapters are dynamically launched.
- Keep session persistence and migration code unchanged because existing sessions are explicitly out of scope.

### Task 1: Establish the failing Codex preset contract

**Files:**

- Modify: `bin/humming-agent.test.ts:71-88`
- Test: `bin/humming-agent.test.ts`

- [ ] **Step 1: Add the exact Codex package assertion**

Extend the existing `supports --json` test after the Claude assertion:

```ts
expect(parsed.find((entry) => entry.id === "codex")).toMatchObject({ source: "built-in" });
expect(parsed.find((entry) => entry.id === "codex")?.args).toEqual([
  "-y",
  "@agentclientprotocol/codex-acp",
]);
```

- [ ] **Step 2: Run the focused test and verify the red state**

Run:

```bash
npx vitest run bin/humming-agent.test.ts -t "supports --json"
```

Expected: FAIL because the current Codex args do not contain the maintained package.

### Task 2: Migrate the built-in preset and current fixtures

**Files:**

- Modify: `bin/agents.ts:58-63`
- Modify: `src/gateway/gateway-agent-switch.test.ts:235-240`
- Modify: `README.md:233-245`
- Test: `bin/humming-agent.test.ts`
- Test: `src/gateway/gateway-agent-switch.test.ts`

- [ ] **Step 1: Replace the production Codex preset**

Change the Codex entry in `bin/agents.ts` to:

```ts
codex: {
  label: "Codex CLI",
  command: "npx",
  args: ["-y", "@agentclientprotocol/codex-acp"],
  description: "OpenAI Codex via the maintained ACP adapter",
},
```

Do not add the adapter to `package.json`, pin a package version, or add migration logic for stored sessions.

- [ ] **Step 2: Update the gateway test resolver fixture**

Change the Codex branch in `src/gateway/gateway-agent-switch.test.ts` to:

```ts
if (selection === "codex") {
  return { command: "npx", args: ["-y", "@agentclientprotocol/codex-acp"], label: "codex" };
}
```

Replace outdated Codex package literals in this test file with `@agentclientprotocol/codex-acp` when they represent the current built-in preset. Do not add a legacy migration fixture because migration of existing sessions is out of scope.

- [ ] **Step 3: Update supported-agent documentation**

Change the Codex row in `README.md` to:

```markdown
| `codex` | 通过维护中的 ACP adapter 接入 OpenAI Codex |
```

- [ ] **Step 4: Run focused tests and verify the green state**

Run:

```bash
npx vitest run bin/humming-agent.test.ts src/gateway/gateway-agent-switch.test.ts
```

Expected: both files pass with zero failed tests.

- [ ] **Step 5: Verify the deprecated package is absent from current code and docs**

Run:

```bash
rg -n -F '@agentclientprotocol/codex-acp' bin src README.md tests
```

Expected: the built-in preset and its current-package fixtures use the maintained package. Do not search or modify persisted files under `~/.humming`; existing sessions are out of scope.

### Task 3: Run project-wide static and automated verification

**Files:**

- Verify: all tracked TypeScript and documentation files

- [ ] **Step 1: Run the full test suite**

Run:

```bash
npm test
```

Expected: Vitest exits 0 with zero failed test files and zero failed tests.

- [ ] **Step 2: Run TypeScript without emitting files**

Run:

```bash
npx tsc --noEmit
```

Expected: exit 0 and no TypeScript diagnostics.

- [ ] **Step 3: Run the repository's formatting check**

Run:

```bash
npm run fmt:check
```

Expected: exit 0 and `All matched files use Prettier code style!`.

- [ ] **Step 4: Check patch whitespace**

Run:

```bash
git diff --check
```

Expected: exit 0 with no output.

- [ ] **Step 5: Build distributable output**

Run:

```bash
npm run build
```

Expected: TypeScript compilation and executable-bit script complete with exit 0.

### Task 4: Prove real maintained-adapter session and request behavior

**Files:**

- Use built output: `dist/src/acp/agent-process.js`
- Use built output: `dist/src/logger/logger.js`
- Do not create a tracked smoke-test file.

- [ ] **Step 1: Run a real ACP smoke script against the maintained package**

Run this script from the repository root:

```bash
node --input-type=module <<'NODE'
import fs from "node:fs/promises";
import { spawnAgent, killAgent } from "./dist/src/acp/agent-process.js";
import { createPinoLogger } from "./dist/src/logger/logger.js";

const expected = "HUMMING_CODEX_ACP_SMOKE_OK";
const chunks = [];
const client = {
  async sessionUpdate({ update }) {
    if (update.sessionUpdate !== "agent_message_chunk") return;
    if (update.content.type === "text") chunks.push(update.content.text);
  },
  async requestPermission() {
    return { outcome: { outcome: "cancelled" } };
  },
  async readTextFile({ path, line, limit }) {
    const content = await fs.readFile(path, "utf8");
    const lines = content.split("\n");
    const start = Math.max(0, (line ?? 1) - 1);
    return { content: lines.slice(start, limit === undefined ? undefined : start + limit).join("\n") };
  },
  async writeTextFile({ path, content }) {
    await fs.writeFile(path, content, "utf8");
    return {};
  },
};

const agent = await spawnAgent({
  command: "npx",
  args: ["-y", "@agentclientprotocol/codex-acp"],
  cwd: process.cwd(),
  client,
  logger: createPinoLogger("warn"),
});

try {
  const result = await Promise.race([
    agent.connection.prompt({
      sessionId: agent.sessionId,
      prompt: [{ type: "text", text: `Reply with exactly ${expected} and nothing else.` }],
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Codex ACP prompt smoke test timed out after 180 seconds")), 180_000),
    ),
  ]);
  const response = chunks.join("");
  if (!response.includes(expected)) {
    throw new Error(`Unexpected Codex ACP response: ${JSON.stringify({ result, response })}`);
  }
  console.log(JSON.stringify({
    package: "@agentclientprotocol/codex-acp",
    sessionCreated: true,
    promptCompleted: true,
    receivedExpectedResponse: true,
  }));
} finally {
  killAgent(agent.process);
}
NODE
```

Expected: exit 0 and JSON containing all three booleans as `true`. This is a live request and may consume model quota. If it fails, report whether the observed failure occurred during package launch, ACP initialization, `newSession`, authentication, prompt processing, or response collection; do not claim migration success.

- [ ] **Step 2: Confirm no smoke-test process remains**

Run:

```bash
pgrep -af '@agentclientprotocol/codex-acp|node_modules/.bin/codex-acp' || true
```

Expected: no process created by the smoke test remains. Existing Gateway-owned Codex processes may still use the old package because existing sessions are explicitly not migrated.

### Task 5: Activate and verify the new preset for future sessions

**Files:**

- Use built CLI: `dist/bin/humming.js`
- Do not alter `~/.humming/sessions.json`.

- [ ] **Step 1: Restart through the supported Gateway command**

Run:

```bash
node dist/bin/humming.js restart
```

Expected: the managed Gateway restarts successfully. If this Gateway was not started through Humming's process-control layer and the command reports `gateway: not running`, do not kill an externally supervised Gateway; report that activation requires its supervisor to restart it.

- [ ] **Step 2: Verify Gateway status**

Run:

```bash
node dist/bin/humming.js status
```

Expected for a managed Gateway: running status with a PID. For an externally supervised Gateway, verify its owning supervisor instead and report the distinction.

- [ ] **Step 3: Verify the built CLI advertises the maintained package**

Run:

```bash
node dist/bin/humming.js agent list --json | node -e '
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const codex = JSON.parse(input).find((entry) => entry.id === "codex");
  if (JSON.stringify(codex?.args) !== JSON.stringify(["-y", "@agentclientprotocol/codex-acp"])) process.exit(1);
  console.log(JSON.stringify({ id: codex.id, command: codex.command, args: codex.args }));
});
'
```

Expected: exit 0 and JSON showing `npx` with `[-y, @agentclientprotocol/codex-acp]`.

- [ ] **Step 4: Review final changes and protect unrelated work**

Run:

```bash
git status --short
git diff -- bin/agents.ts bin/humming-agent.test.ts src/gateway/gateway-agent-switch.test.ts README.md docs/superpowers/specs/2026-08-15-codex-acp-package-migration-design.md docs/superpowers/plans/2026-08-15-codex-acp-package-migration.md
```

Expected: only the migration files plus the pre-existing unrelated untracked incident document are present. Do not modify, stage, or delete `docs/incident-agent-role-bleed-2026-07-26.md`.

No commit step is included because the user did not request a commit.
