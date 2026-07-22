# Request Reaction and Tool Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep each Request message's acknowledgement Reaction until its own Response reaches any terminal outcome, and show the current tool title in the active Card summary.

**Architecture:** Keep Response lifecycle as the single semantic source of truth. `TopicConversationSession` observes terminal Response transitions and owns acknowledgement cleanup; Card visibility and Card rotation no longer affect the Reaction. Summary projection receives Response-wide timeline context so the Presenter can resolve the most recent meaningful Tool title across all Cards while keeping generic processing as a fallback.

**Tech Stack:** TypeScript, Redux Toolkit-backed conversation store, Vitest, Feishu Card JSON 2.0.

## Global Constraints

- Every Request has exactly one corresponding Response.
- Remove the Request Reaction whenever its Response becomes terminal, regardless of whether the outcome is `complete`, `failed`, `interrupted`, `cancelled`, or `merged`.
- Do not remove the Reaction because a Card becomes visible, rotates, awaits permission, or completes one Tool call.
- A Reaction created after its Response became terminal must be removed immediately.
- Reaction removal remains best-effort, idempotent, and retryable after a false/rejected transport result.
- While activity is `calling_tool`, Summary is `<icon> <Agent-provided Tool title>` with no synthetic `tool:` prefix.
- Resolve the Tool title from the whole Response, not only the current tail; fall back to generic processing only when no meaningful title exists.
- Use strict RED → GREEN cycles and do not modify unrelated untracked files.

---

### Task 1: Response-terminal Reaction cleanup

**Files:**

- Modify: `src/conversation/topic-conversation-session.ts`
- Test: `src/conversation/topic-conversation-session.test.ts`
- Test: `src/gateway/gateway-card-lifecycle.test.ts`

**Interfaces:**

- Consumes: `TopicConversationStore.subscribe(listener)` and `ResponseState.kind === "terminal"`.
- Produces: one acknowledgement removal request per terminal Response transition, plus late-attachment cleanup when the Response is already terminal.

- [ ] **Step 1: Replace the first-visible acknowledgement test with a failing lifecycle test**

Add a test that accepts and activates Response A, attaches `reaction-a`, flushes its first visible Card, rotates the Response, and asserts `remove` has not been called. Then call `finishOwner("complete")` and assert `remove("message-a", "reaction-a")` is called exactly once.

```ts
it("keeps acknowledgement through visible Cards and removes it when the Response terminates", async () => {
  const acknowledgement = { add: vi.fn(), remove: vi.fn(async () => true) };
  const { session } = fixture({}, { acknowledgement });
  const a = session.accept({ sourceMessageId: "message-a", content: "A", profile });
  session.attachAcknowledgement(a.responseId, "reaction-a");
  await session.prepare(a.responseId, profile);
  await session.activate(a.responseId);
  await session.flushPresentation();
  await session.rotate(a.responseId, "size");
  await session.flushPresentation();
  expect(acknowledgement.remove).not.toHaveBeenCalled();
  await session.finishOwner("complete");
  await vi.waitFor(() =>
    expect(acknowledgement.remove).toHaveBeenCalledExactlyOnceWith("message-a", "reaction-a"),
  );
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx vitest run src/conversation/topic-conversation-session.test.ts -t "keeps acknowledgement through visible Cards"
```

Expected: FAIL because the current `onCardVisible` callback removes the acknowledgement before the Response terminates.

- [ ] **Step 3: Make terminal transition the sole normal cleanup trigger**

In `TopicConversationSession`:

1. Remove acknowledgement cleanup from `ConversationCardReconciler.onCardVisible`.
2. Subscribe once to `TopicConversationStore` changes.
3. Compare the previous and current snapshots and call `removeAcknowledgement(responseId)` only for Responses whose state changes from non-terminal to terminal.
4. Keep explicit cleanup calls only where they serve late attachment/retry, not as parallel outcome-specific semantic writers.
5. In `attachAcknowledgement`, immediately call `removeAcknowledgement(responseId)` when the current Response is already terminal; do not inspect Card visibility.

Use one helper with this shape:

```ts
private removeAcknowledgementsForNewTerminals(
  previous: TopicConversationSnapshot,
  current: TopicConversationSnapshot,
): void
```

The helper iterates current turns, finds the previous Response state by id, and triggers cleanup only when `current.kind === "terminal"` and the previous state was absent or non-terminal.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
npx vitest run src/conversation/topic-conversation-session.test.ts -t "keeps acknowledgement through visible Cards"
```

Expected: PASS.

- [ ] **Step 5: Add a failing parameterized test for every terminal outcome**

Add coverage for `complete`, `failed`, `interrupted`, and `cancelled` via owner termination, plus `merged` by accepting B and then C while A owns execution. Assert B is removed when B becomes `terminal(merged)`, while C remains until C itself terminates.

```ts
it.each(["complete", "failed", "interrupted", "cancelled"] as const)(
  "removes acknowledgement when a Response becomes terminal(%s)",
  async (outcome) => {
    /* accept, attach, activate, finish, assert exact identity */
  },
);

it("removes a merged Response acknowledgement but keeps the current carrier acknowledgement", async () => {
  /* A active; attach B and C; accepting C merges B; assert B removed and C retained */
});
```

- [ ] **Step 6: Run the terminal-outcome tests and verify RED or existing GREEN deliberately**

Run:

```bash
npx vitest run src/conversation/topic-conversation-session.test.ts -t "removes acknowledgement when|merged Response acknowledgement"
```

Expected before any necessary adjustment: the merged case must prove cleanup comes from the terminal state change itself. If it passes because the new observer already covers it, record that result and continue; do not add duplicate branch logic.

- [ ] **Step 7: Add and pass late-attachment and retry regressions**

Add:

```ts
it("removes a Reaction attached after its Response already terminated", async () => {
  /* finish Response first, attach reaction second, assert removal */
});

it("retries terminal acknowledgement removal after a false transport result", async () => {
  /* false on terminal transition, true on duplicate terminal/late attach signal */
});
```

Ensure `removeAcknowledgement` preserves the map entry after false/rejection and retries only on a later signal, without parallel duplicate calls.

Run:

```bash
npx vitest run src/conversation/topic-conversation-session.test.ts -t "acknowledgement|Reaction attached"
```

Expected: PASS.

- [ ] **Step 8: Strengthen production wiring coverage**

Extend the gateway lifecycle composition test so it proves the production `AcknowledgementPort` is passed into the real runtime/session path and `removeMessageReaction(messageId, reactionId)` is not called on first Card visibility but is called after terminal completion. Keep the existing low-level best-effort adapter assertion.

Run:

```bash
npx vitest run src/gateway/gateway-card-lifecycle.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit Task 1**

```bash
git add src/conversation/topic-conversation-session.ts src/conversation/topic-conversation-session.test.ts src/gateway/gateway-card-lifecycle.test.ts
git diff --cached --name-only
git diff --cached --check
git commit -m "fix(conversation): keep request reaction until response ends"
```

---

### Task 2: Current Tool activity Summary

**Files:**

- Modify: `src/conversation/topic-conversation.ts`
- Modify: `src/conversation/topic-conversation-session.ts`
- Modify: `src/presenter/conversation-card-view.ts`
- Modify: `src/conversation/conversation-card-view-mapper.ts`
- Modify: `src/presenter/lark-presenter.ts`
- Test: `src/conversation/topic-conversation.test.ts`
- Test: `src/conversation/topic-conversation-session.test.ts`
- Test: `src/conversation/conversation-card-view-mapper.test.ts`
- Test: `src/presenter/lark-presenter.test.ts`
- Test: `type-tests/conversation-card-view.test-d.ts` only if the view contract change requires compile-time fixtures.

**Interfaces:**

- Consumes: the Response's current activity and the Tool event that currently owns `calling_tool` activity.
- Produces: current Tool identity/title in Response state and optional `activityTitle?: string` on active views; Presenter renders `🔄 ${activityTitle}` for `calling_tool` and otherwise uses the existing fallback.

- [ ] **Step 1: Write a failing Domain test for current Tool activity ownership**

Add a test that activates Response A, starts Tool 1 with title `Execute`, and expects Response state to identify Tool 1 and its title as the current activity. Complete Tool 1 and expect the current Tool identity/title to be cleared rather than recoverable from the historical timeline entry.

- [ ] **Step 2: Run the focused Domain test and verify RED**

Run:

```bash
npx vitest run src/conversation/topic-conversation.test.ts -t "current Tool activity"
```

Expected: FAIL because `ResponseState` currently stores only `activity: "calling_tool"` and cannot identify which Tool is current.

- [ ] **Step 3: Model current Tool as part of Response activity state**

Change the in-progress Response state so current Tool activity is explicit and mutually consistent:

```ts
type ResponseActivity =
  | { readonly kind: "thinking" }
  | { readonly kind: "waiting" }
  | {
      readonly kind: "calling_tool";
      readonly toolCallId: string;
      readonly title: string | null;
    }
  | { readonly kind: "responding" };
```

Add focused aggregate commands to start/update/finish current Tool activity. A terminal Tool event clears current Tool activity; a later thought/text event replaces it with `thinking`/`responding`. Card rotation does not alter activity state. Never infer current activity from historical timeline entries.

- [ ] **Step 4: Update ACP event translation with strict current-Tool semantics**

In `TopicConversationSession.applyAgentUpdate`:

1. A non-terminal `tool_call` sets current Tool ID/title and appends or updates the Tool timeline entry.
2. A non-terminal `tool_call_update` updates current title only when its `toolCallId` is the current Tool, or establishes it when no current Tool exists and the update is explicitly pending/in-progress.
3. A `completed`/`failed` update clears current Tool activity only when it terminates the current Tool.
4. A terminal-only Tool event is historical output, not an active Tool Summary.
5. Thought/text chunks move current activity to `thinking`/`responding`.

Add regressions proving a completed old Tool cannot overwrite or clear a newer current Tool.

- [ ] **Step 5: Write a failing Presenter test for exact Tool Summary copy**

Add an active `calling_tool` Card test with `activityTitle: "Viewing AccountActions.java"` and assert:

```ts
expect(card.config?.summary?.content).toBe("🔄 Viewing AccountActions.java");
expect(card.config?.summary?.content).not.toContain("tool:");
```

Run:

```bash
npx vitest run src/presenter/lark-presenter.test.ts -t "Tool Summary"
```

Expected: FAIL because current code derives `tool: title` from Card entries.

- [ ] **Step 6: Project only the explicit current activity title**

Extend only the active view variant with optional `activityTitle?: string`. `ConversationCardViewMapper` supplies it only when Response activity is `calling_tool` and its explicit current title is meaningful. It must not inspect older Cards or Tool timeline entries to recover a title.

Update Presenter summary resolution so `calling_tool` uses `view.activityTitle` directly after existing sanitization/truncation. Preserve `STATUS_SUMMARY_DETAIL.calling_tool` as fallback when the explicit current Tool has no title.

- [ ] **Step 7: Add rotation, completion, and fallback regressions**

Prove:

1. While Tool 1 is still current, Card rotation preserves `activityTitle` because Response activity is unchanged.
2. After Tool 1 completes, its old title is no longer used even though its timeline entry remains visible.
3. A late completion for Tool 1 cannot clear Tool 2's current title.
4. A current Tool with a blank/generic title renders `🔄 Agent 正在处理`.
5. Thinking renders its thinking Summary and never a historical Tool title.

Run:

```bash
npx vitest run src/conversation/topic-conversation.test.ts src/conversation/topic-conversation-session.test.ts src/conversation/conversation-card-view-mapper.test.ts src/presenter/lark-presenter.test.ts
```

Expected: PASS.

- [ ] **Step 8: Run type fixtures if the unions changed**

Run:

```bash
npx tsc -p tsconfig.type-tests.json --noEmit
```

Expected: PASS; illegal current-Tool state combinations remain unrepresentable.

- [ ] **Step 9: Commit Task 2**

```bash
git add src/conversation/topic-conversation.ts src/conversation/topic-conversation-session.ts src/presenter/conversation-card-view.ts src/conversation/conversation-card-view-mapper.ts src/presenter/lark-presenter.ts src/conversation/topic-conversation.test.ts src/conversation/topic-conversation-session.test.ts src/conversation/conversation-card-view-mapper.test.ts src/presenter/lark-presenter.test.ts type-tests/conversation-card-view.test-d.ts
git diff --cached --name-only
git diff --cached --check
git commit -m "feat(conversation): show current tool activity in card summary"
```

---

### Task 3: Full verification and publication

**Files:**

- Verify: all task-owned files and `docs/superpowers/specs/conversation-card-lifecycle.md`
- Verify: `docs/superpowers/plans/2026-07-13-request-reaction-tool-summary.md`

**Interfaces:**

- Consumes: Task 1 and Task 2 behavior.
- Produces: pushed `main` revision and, if the running gateway uses this checkout, a rebuilt/restarted runtime on that exact revision.

- [ ] **Step 1: Run formatting on task-owned files**

```bash
npx prettier --write docs/superpowers/specs/conversation-card-lifecycle.md docs/superpowers/plans/2026-07-13-request-reaction-tool-summary.md src/conversation/topic-conversation-session.ts src/conversation/topic-conversation-session.test.ts src/gateway/gateway-card-lifecycle.test.ts src/presenter/conversation-card-view.ts src/conversation/conversation-card-view-mapper.ts src/conversation/conversation-card-view-mapper.test.ts src/presenter/lark-presenter.ts src/presenter/lark-presenter.test.ts type-tests/conversation-card-view.test-d.ts
```

- [ ] **Step 2: Run current quality gates after formatting**

```bash
npm test
npm run build
npm run fmt:check
npx tsc -p tsconfig.type-tests.json --noEmit
```

Expected: every command exits 0 with no skipped task-owned regression.

- [ ] **Step 3: Inspect and commit documentation if not already committed**

```bash
git status --short
git diff -- docs/superpowers/specs/conversation-card-lifecycle.md docs/superpowers/plans/2026-07-13-request-reaction-tool-summary.md
git add docs/superpowers/specs/conversation-card-lifecycle.md docs/superpowers/plans/2026-07-13-request-reaction-tool-summary.md
git diff --cached --name-only
git diff --cached --check
git commit -m "docs(conversation): define response-scoped reactions and tool summaries"
```

Preserve unrelated untracked documents.

- [ ] **Step 4: Push and verify upstream**

```bash
git push origin main
git status --short
git rev-parse HEAD
git rev-parse origin/main
```

Expected: `HEAD` equals `origin/main`; only unrelated pre-existing untracked files remain.

- [ ] **Step 5: Rebuild and restart the linked development runtime**

First verify the active command target and launch descriptor without mutating them. If the active runtime is linked to this development checkout:

```bash
npm run build
humming restart
humming status
```

Expected: restart completes, PID changes, WebSocket is ready, and runtime revision equals pushed `HEAD`. If the runtime is not linked to this checkout, report that deployment was intentionally not performed rather than switching checkout ownership implicitly.
