# Topic Repository Binding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow each Feishu topic to override its chat's default repository while preserving existing chat-level bindings.

**Architecture:** Extend each `bindings[chatId]` entry with optional `topics[threadId].cwd`. Resolve repositories as topic override → chat default → runtime default → reception, while keeping `SessionRecord.cwd` as existing Agent-session state rather than migrating it into bindings.

**Tech Stack:** TypeScript 5 strict mode, Zod, Commander, Vitest, atomic JSON settings store.

---

### Task 1: Extend the binding model and settings adapter

**Files:**

- Modify: `src/binding-store/binding-store.ts`
- Modify: `src/binding-store/settings-binding-store.ts`
- Modify: `src/binding-store/settings-binding-store.test.ts`
- Modify: `bin/cli/config/schema.ts`

- [ ] **Step 1: Add failing store tests**

Cover legacy chat bindings, topic overrides, topic-only chat entries, removal of one topic without affecting siblings, and removal of chat `cwd` while retaining topics:

```ts
expect(await store.get("chat-a")).toMatchObject({
  chatId: "chat-a",
  cwd: "/repo/default",
  topics: {
    "thread-a": { cwd: "/repo/topic-a" },
  },
});
```

- [ ] **Step 2: Run the focused tests and confirm RED**

```bash
npx vitest run src/binding-store/settings-binding-store.test.ts
```

Expected: failures because `ChatBinding.cwd` is required and topic data is not loaded or persisted.

- [ ] **Step 3: Add the minimal data model and scoped helpers**

```ts
export type TopicRepositoryBinding = {
  readonly cwd: string;
};

export type ChatBinding = {
  readonly chatId: string;
  readonly cwd?: string;
  readonly topics?: Readonly<Record<string, TopicRepositoryBinding>>;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type RepositoryScope =
  { readonly kind: "chat" } | { readonly kind: "topic"; readonly threadId: string };
```

Add store operations that set/delete one scope while preserving the remaining fields. Delete `bindings[chatId]` only when neither chat `cwd` nor topic entries remain. Use conditional spreads rather than assigning `undefined` under `exactOptionalPropertyTypes`.

- [ ] **Step 4: Extend Zod parsing and settings persistence**

Accept both existing `{ cwd: string }` and new `{ cwd?: string, topics?: Record<string, { cwd: string }> }`; reject empty entries. Preserve credentials, runtime settings, sibling chats, and sibling topics during writes.

- [ ] **Step 5: Run focused tests and confirm GREEN**

```bash
npx vitest run src/binding-store/settings-binding-store.test.ts
```

Expected: PASS.

---

### Task 2: Make slash binding commands topic-aware

**Files:**

- Modify: `src/interpreter/commands.ts`
- Modify: `src/interpreter/commands.test.ts`
- Modify: `src/gateway/gateway.ts`
- Modify: `tests/binding-routing.test.ts`

- [ ] **Step 1: Add failing parser and routing tests**

Cover:

```text
/bind /repo/topic          # current scope
/bind --chat /repo/default # explicit chat scope
/unbind                    # current scope
/unbind --chat             # explicit chat scope
```

Verify that a topic command changes only that topic, a chat-default change leaves explicit topic overrides intact, and main-chat commands operate on the chat default.

- [ ] **Step 2: Run focused tests and confirm RED**

```bash
npx vitest run src/interpreter/commands.test.ts tests/binding-routing.test.ts
```

Expected: failures because slash commands and Gateway handlers currently pass only `chatId`.

- [ ] **Step 3: Add command scope to parsed commands**

```ts
export type BindingCommandScope = "current" | "chat";

// bind command payload
{
  readonly kind: "bind";
  readonly cwd: string;
  readonly scope: BindingCommandScope;
}
```

Parse `--chat` only in the documented position, reject unknown flags, and update help text. Interpret `current` as topic scope when `threadId !== null`, otherwise chat scope.

- [ ] **Step 4: Resolve effective bindings with thread context**

Change Gateway repository resolution to accept `(chatId, threadId)` and apply:

```text
topic override → chat cwd → runtime.cwd → reception cwd
```

Pass `threadId` through normal message routing, `/where`, Agent startup, and command handlers. `/where` should identify whether the selected repository came from the topic or chat binding.

- [ ] **Step 5: Limit reset scope**

When a topic's effective cwd changes, call the existing topic teardown/session-clear paths only for that `(chatId, threadId)`. When chat `cwd` changes, reset the main chat and topics without explicit overrides; do not reset overridden topics. If the effective path stays equal, persist the binding change without resetting the session.

- [ ] **Step 6: Run focused tests and confirm GREEN**

```bash
npx vitest run src/interpreter/commands.test.ts tests/binding-routing.test.ts
```

Expected: PASS.

---

### Task 3: Use the same effective repository in CLI session commands

**Files:**

- Modify: `bin/cli/context.ts`
- Modify: `bin/cli/commands/session.ts`
- Modify: `bin/humming-session.test.ts`
- Modify: `src/gateway/control-server.ts`
- Modify: `src/gateway/control-server.test.ts`
- Modify: `src/gateway/gateway.ts`
- Modify: `src/gateway/gateway-agent-switch.test.ts`

- [ ] **Step 1: Add failing CLI and control-protocol tests**

Verify:

- `session list` and `session bind` use topic override before chat default.
- Explicit `session list --cwd` remains a query-only override.
- `session configure --agent --cwd` sends an explicit binding change.
- A topic request stores a topic override; a main-chat request stores chat `cwd`.
- `session configure --agent` without explicit `--cwd` does not create a binding.

- [ ] **Step 2: Run focused tests and confirm RED**

```bash
npx vitest run bin/humming-session.test.ts src/gateway/control-server.test.ts src/gateway/gateway-agent-switch.test.ts
```

Expected: failures because CLI context ignores topic bindings and configure requests do not persist explicit cwd as a binding.

- [ ] **Step 3: Share binding precedence in CLI context**

Update CLI cwd lookup to read `bindings[chatId].topics[threadId]` before `bindings[chatId].cwd`, then runtime fallbacks. Keep an explicitly passed command `--cwd` highest priority where that command already supports it.

- [ ] **Step 4: Extend configure control input minimally**

```ts
type ConfigureSessionInput = {
  readonly targetAgent?: PendingTargetAgent;
  readonly bindingCwd?: string;
  readonly controls?: SessionControlPatch;
  readonly message?: PendingSessionMessage;
};
```

Set `bindingCwd` only when the user explicitly supplied both `--agent` and `--cwd`. Gateway writes it to the current topic scope, or chat scope for `threadId === null`, before continuing through the existing Agent-switch flow. Do not add migration or a transaction layer.

- [ ] **Step 5: Run focused tests and confirm GREEN**

```bash
npx vitest run bin/humming-session.test.ts src/gateway/control-server.test.ts src/gateway/gateway-agent-switch.test.ts
```

Expected: PASS.

---

### Task 4: Cover settings hot reload and lifecycle boundaries

**Files:**

- Modify: `tests/reception-hot-reload.test.ts`
- Modify: `src/session-store/file-session-store.test.ts` only if an existing assertion needs clarification

- [ ] **Step 1: Add failing integration tests**

Cover a single chat with two topics using different repositories, hot reload of one topic override, chat-default reload that leaves overridden topics running, and `/new` preserving both chat and topic bindings.

- [ ] **Step 2: Run integration tests and confirm RED**

```bash
npx vitest run tests/reception-hot-reload.test.ts tests/binding-routing.test.ts
```

Expected: failures where current hot reload tears down the whole chat.

- [ ] **Step 3: Make hot reload compare scoped effective cwd values**

Include topic maps in binding snapshots. For each known main/topic scope, compare old and new effective paths and reset only scopes whose path changed. Preserve the existing last-known-good behavior for malformed or half-written settings files.

- [ ] **Step 4: Run integration tests and confirm GREEN**

```bash
npx vitest run tests/reception-hot-reload.test.ts tests/binding-routing.test.ts
```

Expected: PASS.

---

### Task 5: Update guidance and run full verification

**Files:**

- Modify: `CLAUDE.md`
- Modify: `templates/home/AGENTS.md`
- Modify: `templates/home/settings.back.json`
- Modify: `README.md`
- Modify: `src/home-templates.test.ts` if template assertions require updates

- [ ] **Step 1: Document the final behavior**

Document:

```text
topic /bind <path>     → current topic override
main  /bind <path>     → chat default
topic /bind --chat ... → chat default
topic /unbind          → remove topic override and inherit
main  /unbind          → remove chat default, preserve topics
/new                    → reset session only, preserve bindings
```

State that `session configure --agent --cwd` updates the current binding scope, while `session bind` still does not accept `--cwd`. Keep Agent/Model/Mode/Permission/Config out of bindings.

- [ ] **Step 2: Run all focused suites**

```bash
npx vitest run src/binding-store/settings-binding-store.test.ts src/interpreter/commands.test.ts tests/binding-routing.test.ts tests/reception-hot-reload.test.ts bin/humming-session.test.ts src/gateway/control-server.test.ts src/gateway/gateway-agent-switch.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run the repository verification suite**

```bash
npx tsc --noEmit
npx eslint .
npx prettier --check .
npm test
```

Expected: all commands exit successfully.
