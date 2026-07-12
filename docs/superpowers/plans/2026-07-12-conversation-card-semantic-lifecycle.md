# Conversation Card Semantic Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Humming's independently mutable card fields and direct patch paths with one token-safe, monotonic per-prompt semantic lifecycle that cannot render stale actionable or misleading receipt cards.

**Architecture:** A pure `PromptCardLifecycle` reducer owns semantic state; `PromptCallbackRouter` scopes ACP callbacks using the protocol response boundary; `ConversationCardDelivery` owns only transport generations and atomic close/handoff; the presenter renders an exhaustive discriminated view union. Live routing stays behind one `conversationCardLifecycleV2` gate until the single-writer cutover is complete.

**Tech Stack:** TypeScript 5.9, Node.js 20+, Vitest, ACP SDK 0.16, Lark SDK 1.65.

## Global Constraints

- Use strict RED-GREEN-REFACTOR for every behavioral slice.
- Never expose private chat/thread/session IDs, local paths, hostnames, or action tokens in user-facing copy or logs.
- Do not add a standalone durable “message received / processing” card.
- Only an active semantic view may contain a Cancel action.
- Prompt, segment, permission, action, and ownership tokens are opaque and unguessable.
- Semantic reduction never waits for Feishu network I/O.
- Active render updates remain coalesced at 100 ms; close/handoff/terminal effects bypass debounce.
- Conversation-card rotation remains exactly 8192 UTF-8 bytes.
- No intermediate commit enables mixed legacy/v2 semantic writers.
- Each task ends with targeted tests, full relevant tests, build, format check on touched files, an independent spec review, an independent quality review, commit, and push.
- Preserve unrelated worktree changes; stage only task-owned files.

## File map

- Create `src/presenter/conversation-card-view.ts`: semantic view discriminated union and pure rendering helpers shared by lifecycle and presenter.
- Create `src/presenter/conversation-card-view.test.ts`: runtime cloning/view invariant checks.
- Create `src/acp/prompt-card-lifecycle.ts`: pure per-prompt state, event reducer, ToolLedger, render generations, immutable snapshot helper.
- Create `src/acp/prompt-card-lifecycle.test.ts`: transition table, terminal absorption, tool matrix, idle/flush generations.
- Create `src/acp/prompt-callback-router.ts`: ACP callback entry-time route capture and protocol response boundary.
- Create `src/acp/prompt-callback-router.test.ts`: active/closed routing, stale permission cancellation, and connection quarantine.
- Modify `src/acp/conversation-card-delivery.ts`: ownership token, atomic close, permission handoff, orphan reconciliation.
- Modify `src/acp/conversation-card-delivery.test.ts`: deferred transport race matrix.
- Create `src/acp/prompt-card-controller.ts`: reducer/effect runner, render coalescing, lifecycle-owned delivery integration.
- Create `src/acp/prompt-card-controller.test.ts`: end-to-end lifecycle with deferred transport.
- Modify `src/acp/humming-client.ts`: retain ACP client responsibilities but delegate prompt rendering/permissions to controller.
- Modify `src/acp/humming-client.test.ts`: adapter behavior and legacy removal tests.
- Modify `src/presenter/presenter.ts`: replace legacy free-form `UnifiedCardState` with v2 `ConversationCardView` at the gated boundary.
- Modify `src/presenter/lark-presenter.ts`: exhaustive render by view kind and v2 action payload.
- Modify `src/presenter/lark-presenter.test.ts`: no illegal action/header combinations.
- Modify `src/lark/lark-http.ts`: add/remove acknowledgement reaction methods.
- Create/modify `src/lark/lark-http.test.ts`: reaction request shape and failure behavior.
- Modify `src/bridge/chat-runtime.ts`: own one PromptCardLifecycle per accepted message, install prompt routes, map terminal reasons.
- Modify `src/bridge/chat-runtime.test.ts`: queue ownership, old update draining, shutdown/supersede.
- Modify `src/bridge/bridge.ts`: reaction acknowledgement, gated v2 routing, token-validated Cancel, remove direct conversation-card patches.
- Modify bridge tests (`src/bridge/bridge-agent-switch.test.ts` and/or a focused new `src/bridge/bridge-card-lifecycle.test.ts`): callback versioning, stale Cancel, no receipt card, no bypass.
- Modify `templates/home/settings.back.json`: document the disabled-by-default feature gate.
- Modify `bin/humming.ts` and `bin/process-control.ts`: feature enable/disable and rollback-safe restart commands.
- Create `tsconfig.type-tests.json` and `type-tests/conversation-card-view.test-d.ts`: compile-time illegal-state checks.
- Create `src/presenter/legacy-conversation-card-adapter.ts`: the only gate-off wrapper allowed to call legacy `sendUnifiedCard` / `updateUnifiedCard` after cutover preparation.
- Create `src/bridge/conversation-card-feature.ts`: injectable gate contract and disabled default used before persisted configuration exists.

---

### Task 1: Legacy Cancel Compatibility Guard — COMPLETED (`4700e9d`)

**Files:**
- Modified: `src/bridge/bridge.ts`
- Created: `src/bridge/bridge-card-lifecycle.test.ts`

**Verified TDD evidence:**
- [x] RED proved a versioned Cancel reached runtime lookup before the guard.
- [x] GREEN rejects every Cancel payload with an own `v` field before runtime lookup.
- [x] Legacy unversioned Cancel remains functional while v2 is disabled.
- [x] Focused bridge/runtime suite: 30/30 passed.
- [x] Build, Prettier, and diff checks passed.
- [x] Independent specification review: PASS.
- [x] Commit `4700e9d` pushed to `origin/main`.

---

### Task 2: Semantic View Union

**Files:**
- Create: `src/presenter/conversation-card-view.ts`
- Create: `type-tests/conversation-card-view.test-d.ts`
- Create: `tsconfig.type-tests.json`
- Modify: `src/presenter/index.ts`

**Interfaces:**
- Produces: `PromptToken`, `SegmentToken`, `ActionToken`, `PermissionToken`, `OwnershipToken`, `ConversationCardView`, `CancelActionPayloadV2`, `cloneCardView(view)`.
- Consumes: legacy text/thought/tool data shape for conversion, but defines new v2 `ActiveTimelineEntry`, `ArchivedTimelineEntry`, and `TerminalTimelineEntry`. V2 `ToolStatus` includes `interrupted`; it does not reuse the legacy presenter `TimelineEntry` type.

- [ ] **Step 1: Write failing compile/runtime invariant tests**

Create exactly:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": true, "rootDir": "." },
  "include": ["src/presenter/conversation-card-view.ts", "type-tests/**/*.test-d.ts"],
  "exclude": ["node_modules", "dist"]
}
```

Put `@ts-expect-error` checks in `type-tests/conversation-card-view.test-d.ts`. First run `npx tsc -p tsconfig.type-tests.json --noEmit --listFiles` and assert the fixture path appears. Include one deliberate unused `@ts-expect-error` during RED to prove the fixture is checked, then replace it with the actual illegal archived/terminal action assertions for GREEN.

```ts
const archived: ConversationCardView = {
  kind: "archived",
  entries: [text("done")],
  summary: "done",
  route,
  // @ts-expect-error archived cards cannot be actionable
  cancelAction,
};
```

Add runtime clone tests in a small colocated Vitest file or the type module's focused test. Mutate nested entry text, tool detail, profile, route/action payload, and nested permission data after cloning and assert the snapshot stays unchanged:

```ts
const snapshot = cloneCardView(activeView);
activeView.entries[0]!.text = "mutated";
expect(snapshot.entries[0]).toMatchObject({ text: "original" });
```

- [ ] **Step 2: Verify RED**

Run `npx tsc -p tsconfig.type-tests.json --noEmit` and the focused runtime test.
Expected: missing module/types and failed type expectations before implementation.

- [ ] **Step 3: Implement focused types and clone helper**

Use a discriminated union with no free `cancellable`. `CardRoute` supplies `{ c, th? }`; `active.cancelAction` supplies `{ p, s, a }`; only the renderer combines them into `{ v: 2, cancel: true, c, th?, p, s, a }`. Define the v2 tool status union with `interrupted`. Implement `cloneCardView` with `structuredClone`; recursively freeze only outside production.

- [ ] **Step 4: Verify GREEN**

Run the focused runtime test, `npx tsc -p tsconfig.type-tests.json --noEmit`, `npm run build`, and Prettier check for all touched files.

- [ ] **Step 5: Review, commit, push**

Commit message: `feat(cards): define semantic conversation views`.

---

### Task 3: Pure Prompt Lifecycle Reducer

**Files:**
- Create: `src/acp/prompt-card-lifecycle.ts`
- Create: `src/acp/prompt-card-lifecycle.test.ts`
- Modify: `src/acp/index.ts`

**Interfaces:**
- Consumes: semantic tokens/views from Task 2 and card text budget helpers.
- Produces:

```ts
interface TransitionDiagnostic {
  readonly promptSequence: number;
  readonly segmentSequence: number | null;
  readonly from: SemanticPhase;
  readonly to: SemanticPhase;
  readonly event: ConversationCardEvent["type"];
  readonly entryCount: number;
  readonly utf8Bytes: number;
  readonly actionRevoked: boolean;
  readonly staleReason?: StaleEventReason;
}
interface TransitionResult {
  readonly next: PromptLifecycleState;
  readonly effects: readonly CardEffect[];
  readonly diagnostic: TransitionDiagnostic;
}
createPromptLifecycle(input: CreatePromptLifecycleInput): PromptLifecycleState
reducePromptLifecycle(state: PromptLifecycleState, event: ConversationCardEvent): TransitionResult
viewForPromptState(state: PromptLifecycleState): ConversationCardView | null
```

- [ ] **Step 1: RED/GREEN — create and queued/starting transitions**

Write only creation plus `queued -> starting` / `interrupting -> starting` tests. Run RED because reducer functions do not exist; implement the smallest state/event shapes to make these tests GREEN; rerun.

- [ ] **Step 2: RED/GREEN — forwarded, archive, and terminal absorption**

Add one failing behavior at a time: starting->active with action token, non-empty archive/open next segment using event-supplied next segment/action tokens, finish from each live phase, terminal absorbing, stale prompt/segment rejection. After each failing assertion, implement only that transition and rerun before adding the next test.

- [ ] **Step 3: RED/GREEN — ToolLedger matrix**

Add matrix rows incrementally: absent/pending, pending->in_progress, direct pending->completed/failed, initial terminal, duplicate/conflicting terminal, cross-segment marker, then terminal normalization. Tool events update prompt-level ledger but carry `displaySegmentToken` for display placement; text/thought/archive tests prove stale segment tokens are rejected. Each row must fail for semantic output—not missing symbols—before its minimal implementation.

- [ ] **Step 4: RED/GREEN — render timer and idle semantics**

First add one-timer/latest-view RED and implement it. Then add update-after-callback RED and implement second-timer scheduling. Then add archive/permission/finish invalidation and already-reduced-idle close tests individually.

- [ ] **Step 5: RED/GREEN — diagnostics and seeded generated sequences**

Add diagnostic shape/serialization tests, implement bounded `TransitionDiagnostic`, then add the seeded sequence generator. After every generated event assert view invariants and terminal absorption; serializer tests reject raw tokens, content, IDs, and paths. Delivery outcome is intentionally not in reducer diagnostics and is recorded by Task 5's delivery diagnostic port.

- [ ] **Step 6: Verify**

Run targeted tests, build, and Prettier. Expected: all transition cases pass.

- [ ] **Step 7: Review, commit, push**

Commit message: `feat(cards): add prompt semantic lifecycle reducer`.

---

### Task 4: ACP Prompt Callback Router and Protocol Boundary

**Files:**
- Create: `src/acp/prompt-callback-router.ts`
- Create: `src/acp/prompt-callback-router.test.ts`
- Modify: `src/acp/agent-process.ts`
- Modify: `src/acp/agent-process.test.ts`

**Interfaces:**
- `PromptCallbackRouter` is the sole `acp.Client` supplied to `ClientSideConnection`.
- It owns session-scoped delegates and one optional active prompt route:

```ts
class PromptCallbackRouter implements acp.Client {
  activateBootstrap(mode: "new" | "load" | "resume", callbacks: BootstrapCallbacks): BootstrapRouteHandle;
  closeBootstrap(handle: BootstrapRouteHandle): void;
  activate(promptToken: PromptToken, callbacks: PromptScopedCallbacks): PromptRouteHandle;
  close(handle: PromptRouteHandle): void;
  isConnectionHealthy(): boolean;
  requestPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse>;
  sessionUpdate(params: acp.SessionNotification): Promise<void>;
}
```

- `HummingClient` and `PromptCardController` are active-route callbacks, not second ACP clients.

- [ ] **Step 1: RED/GREEN — bootstrap replay isolation and session metadata**

Add `loadSession` history replay tests first: user/agent/thought/plan/tool updates under `bootstrap/load` go only to `BootstrapCallbacks` and never to a PromptCardController; session-info/mode/config/commands/usage go to SessionCallbacks. Implement bootstrap activate/close and classification, rerunning after each update class. Add new/resume setup route tests.

- [ ] **Step 2: RED/GREEN — entry-time active route capture**

Write the route-capture test, run RED, implement only activate/close/sessionUpdate capture, then run GREEN. Use a deferred callback: enter `sessionUpdate` under prompt A, close A and activate B before the callback resolves, and assert the update still carries A. Then add/implement the session-metadata delegate case.

- [ ] **Step 3: RED/GREEN — ACP response boundary and protocol violations**

Add update-after-close RED and implement unhealthy quarantine; then add permission-after-close RED and implement immediate `{ outcome: { outcome: "cancelled" } }`; rerun after each. No callback is assigned to the next prompt by current-token lookup.

- [ ] **Step 4: RED/GREEN — cancellation ordering**

Add the trailing-update-after-cancel test, implement route retention until prompt response, rerun; then add unresolved-permission cancellation and implement it.

- [ ] **Step 5: Implement remaining router/connection construction**

`spawnAndInit({ client: router })` installs exactly this object. Expose unhealthy state so ChatRuntime restarts the connection before another prompt. Do not use a quiescence timer.

- [ ] **Step 6: Verify**

Run router + agent-process tests, build, and Prettier.

- [ ] **Step 7: Review, commit, push**

Commit message: `feat(acp): scope callbacks to protocol prompt turns`.

---

### Task 5: Delivery Atomic Close and Permission Handoff

**Files:**
- Modify: `src/acp/conversation-card-delivery.ts`
- Modify: `src/acp/conversation-card-delivery.test.ts`

**Interfaces:**
- Consumes: immutable `ConversationCardView` and ownership token.
- Produces:

```ts
interface DeliveryDiagnostic {
  readonly ownerSequence: number;
  readonly operation: "adopt" | "send" | "patch" | "close" | "permission_reuse" | "permission_send" | "reconcile";
  readonly outcome: "pending" | "visible" | "rejected" | "failed" | "superseded" | "reused";
}
createOwner(context: CardDeliveryContext): OwnershipToken
adopt(owner: OwnershipToken, cardId: string): void
deliver(owner: OwnershipToken, view: ConversationCardView): Promise<DeliveryResult>
close(owner: OwnershipToken, view: NonActionableView): OwnershipToken
handoffToPermission(owner: OwnershipToken, request: PermissionHandoffRequest): Promise<PermissionHandoffResult>
reconcileSuperseded(cardId: string, view: OrphanedView): Promise<void>
```

`createOwner` is called when one `PromptCardLifecycle` is allocated. `adopt` attaches an already-created queued card to that same owner; transition to starting/active preserves owner identity until close. Every operation reports a real `DeliveryDiagnostic` through an injected bounded diagnostics port.

- [ ] **Step 1: RED/GREEN — owner creation, adoption, and delivery diagnostics**

Add createOwner/adopt tests, run RED, implement them, rerun. Then add one diagnostic outcome at a time (`pending`, `visible`, `rejected`, `failed`, `superseded`, `reused`) and minimally implement/report it before the next.

- [ ] **Step 2: RED/GREEN — atomic close ordering**

With deferred patch, add the close-order test, run RED, implement close returning a fresh owner immediately, rerun. Then add fresh-owner progress while old promise hangs and implement per-owner queues.

- [ ] **Step 3: RED/GREEN — terminal over queued Waiting**

Add Waiting-hung-then-terminal RED, implement barrier behavior, rerun; then add no-migration-to-fresh-owner assertion.

- [ ] **Step 4: RED/GREEN — permission handoff matrix**

Add and implement separately: reuse success, reuse rejection+single fresh send, fresh send failure, finish/cancel during handoff, stale successful permission send through permission expiry. Preserve prompt/permission tokens in the handoff request.

- [ ] **Step 5: RED/GREEN — superseded send and immutable inputs**

Add stale send ID RED, implement orphan reconciliation, rerun. Then mutate each nested input class after delivery and implement clone/freeze at the boundary until all remain immutable.

- [ ] **Step 6: Verify and commit**

Run delivery tests, build, Prettier. Commit: `feat(cards): add atomic lifecycle ownership handoff`.

---

### Task 6: Prompt Card Controller

**Files:**
- Create: `src/acp/prompt-card-controller.ts`
- Create: `src/acp/prompt-card-controller.test.ts`

**Interfaces:**
- Consumes: reducer (Task 3), router tokens (Task 4), delivery (Task 5), presenter ports.
- Produces intent API:

```ts
interface PromptCardController {
  acknowledge(input: { messageId: string; reactionId?: string }): void;
  markQueued(): void;
  markInterrupting(): void;
  markPreparing(profile: SessionCardMeta | null): void;
  markForwarded(): { promptToken: PromptToken; segmentToken: SegmentToken; actionToken: ActionToken };
  applyAgentUpdate(update: acp.SessionNotification["update"]): void;
  requestPermission(input: {
    requestId: string;
    params: acp.RequestPermissionRequest;
  }): { promptToken: PromptToken; permissionToken: PermissionToken };
  consumePermission(input: {
    promptToken: PromptToken;
    permissionToken: PermissionToken;
    requestId: string;
    optionId: string;
  }): "accepted" | "stale" | "duplicate" | "invalid_option";
  consumeCancel(input: {
    promptToken: PromptToken;
    segmentToken: SegmentToken;
    actionToken: ActionToken;
  }): "accepted" | "stale" | "duplicate";
  finish(outcome: TerminalOutcome): void;
  onFirstVisibleCard(listener: (cardId: string) => void): () => void;
  onTerminalWithoutVisibleCard(listener: () => void): () => void;
  awaitEffects(timeoutMs: number): Promise<void>;
}
```

- [ ] **Step 1: RED/GREEN — active/archive/terminal screenshot regressions**

Add delayed-running-patch+archive RED, implement minimal effect orchestration, rerun. Then separately add terminal+late-update and exactly-one-action-token cases, implementing each before the next.

- [ ] **Step 2: RED/GREEN — 100 ms coalescing**

Add multiple-chunks-one-delivery RED, implement timer wiring, rerun; then add terminal-cancels-flush RED and implement immediate close.

- [ ] **Step 3: RED/GREEN — permission, actions, and ToolLedger integration**

Add separately and implement after each RED: content boundary, empty reuse, failed handoff, cross-boundary tool completion, finish awaiting permission, consumePermission request/option membership, duplicate/stale permission, consumeCancel duplicate/stale.

- [ ] **Step 4: RED/GREEN — acknowledgement lifecycle callbacks**

Add first-visible feedback RED and implement the `acknowledgement_visible` reducer event emitted only from `DeliveryResult.visible(cardId)`. Then add terminal-without-visible RED and implement `acknowledgement_terminal_without_card`. Assert either event emits exactly one `remove_acknowledgement` effect, and removal success/failure feedback marks the attempt complete without retries.

- [ ] **Step 5: Complete effect runner**

Semantic calls return immediately after reducer commit; effect promises are tracked only for bounded `awaitEffects` and never block reducer events.

- [ ] **Step 6: Verify and commit**

Run controller/reducer/delivery tests, build, Prettier. Commit: `feat(cards): orchestrate prompt card lifecycle`.

---

### Task 7: Disabled Gate Contract and Exhaustive Lark Presenter V2

**Files:**
- Create: `src/bridge/conversation-card-feature.ts`
- Create: `src/bridge/conversation-card-feature.test.ts`
- Modify: `src/presenter/presenter.ts`
- Modify: `src/presenter/lark-presenter.ts`
- Modify: `src/presenter/lark-presenter.test.ts`
- Modify: `src/presenter/index.ts`

**Interfaces:**
- Consumes: `ConversationCardView`.
- Produces `ConversationCardFeatureGate { readonly v2Enabled: boolean }`, exported `DISABLED_CONVERSATION_CARD_FEATURE = { v2Enabled: false }`, and gated v2 presenter methods. Until Task 12 supplies persisted config, every production constructor defaults/injects the disabled contract. Tests for Tasks 7–11 explicitly inject true only into isolated fixtures; each task asserts the default live route remains legacy.

- [ ] **Step 1: RED/GREEN — disabled gate contract**

Add default/injection tests, run RED, implement the immutable disabled default and constructor injection, rerun. Assert production construction without explicit injection cannot call v2 presenter methods.

- [ ] **Step 2: RED/GREEN — exhaustive rendering**

For each view kind assert exact header presence, footer presence, summary, body, and actions. Specifically assert archived has no header/footer/button; terminal has header/no button; queued/starting no button; orphaned neutral/no button. Only active emits the exact Cancel wire schema `{ v: 2, cancel: true, c, th?, p, s, a }` by combining route and action fields. Permission cards emit `{ v: 2, c, th?, p, q, r, o }`.

- [ ] **Step 3: RED/GREEN — impossible view rejection**

At runtime boundary, malformed external test fixtures are rejected/logged rather than silently normalized.

- [ ] **Step 4: Implement remaining exhaustive renderer plumbing**

No lifecycle conditions outside switch-by-kind. Preserve existing markdown panels and card-size helpers.

- [ ] **Step 5: Verify and commit**

Run presenter + feature-gate + budget tests, build, Prettier. Commit: `feat(cards): render semantic conversation views`.

---

### Task 8: Reaction Acknowledgement Port

**Files:**
- Modify: `src/lark/lark-http.ts`
- Create: `src/lark/lark-http.test.ts` if no focused HTTP test exists.

**Interfaces:**
- Produces:

```ts
addMessageReaction(messageId, emojiType): Promise<string>
removeMessageReaction(messageId, reactionId): Promise<void>
```

- [ ] **Step 1: RED — SDK request shape**

Assert create calls `im.v1.messageReaction.create` with `{ reaction_type: { emoji_type } }` and returns `reaction_id`; delete uses message and reaction IDs.

- [ ] **Step 2: Implement methods**

Methods throw transport errors; bridge/controller decides best-effort behavior.

- [ ] **Step 3: Verify and commit**

Run HTTP tests, build, Prettier. Commit: `feat(lark): support prompt acknowledgement reactions`.

---

### Task 9: HummingClient Adapter Migration Behind Gate

**Files:**
- Modify: `src/acp/humming-client.ts`
- Modify: `src/acp/humming-client.test.ts`

**Interfaces:**
- Consumes: controller and router.
- Produces: ACP client delegate methods without mutable semantic status/timeline/card ID state in v2 mode.

- [ ] **Step 1: RED — delegate behavior**

Assert v2 session updates enter controller with router-provided token; permission request uses PermissionToken; finalization is absorbing; late callback during drain does not reach controller.

- [ ] **Step 2: RED — no parallel v2 state**

Add source-level/behavior test proving v2 path does not own free `status`, `cancellable`, `idleStatusCardPending`, `permissionBoundaryThisPrompt`, or `flushing` state.

- [ ] **Step 3: Implement gated adapter**

Legacy path remains unchanged when gate is false. V2 path delegates semantic behavior; file read/write and session metadata remain session-scoped.

- [ ] **Step 4: Verify and commit**

Run HummingClient and all new ACP tests, build, Prettier. Commit: `refactor(cards): delegate ACP rendering to lifecycle`.

---

### Task 10: ChatRuntime Per-Prompt Ownership and Legacy Writer Isolation

**Files:**
- Create: `src/presenter/legacy-conversation-card-adapter.ts`
- Create: `src/presenter/legacy-conversation-card-adapter.test.ts`
- Modify: `src/acp/humming-client.ts`
- Modify: `src/bridge/chat-runtime.ts`
- Modify: `src/bridge/chat-runtime.test.ts`

**Interfaces:**
- Consumes: PromptCardController, PromptCallbackRouter, explicit terminal outcome map.
- Produces: one lifecycle per `PendingMessage`, including queued messages.

- [ ] **Step 1: RED — first, second, and third queued prompts**

Assert first follow-up may transition queued->interrupting->starting; later queued prompts transition queued->starting directly; each retains one card ownership.

- [ ] **Step 2: RED — prompt drain barrier**

After prompt response, close the route. Send a protocol-violating late update and permission request; assert the update is rejected, permission returns cancelled, the connection is quarantined/restarted, and neither is assigned to the next prompt.

- [ ] **Step 3: RED — terminal reason table**

Cover normal complete, explicit cancel, agent error, shutdown, supersede, bootstrap failure, permission-pending termination. Assert supersede is not success.

- [ ] **Step 4: RED/GREEN — isolate every legacy writer**

Add a full-`src/` inventory test for direct `sendUnifiedCard`/`updateUnifiedCard` references. Move production legacy calls from bridge/runtime/HummingClient behind `legacy-conversation-card-adapter.ts`, preserving behavior after each move. The temporary allowlist becomes exactly:

```text
src/presenter/lark-presenter.ts
src/presenter/legacy-conversation-card-adapter.ts
src/acp/conversation-card-delivery.ts
```

Tests may reference methods but production files outside the allowlist may not. Include new v2 `sendConversationCard`/`updateConversationCard` names in the scanner.

- [ ] **Step 5: Implement remaining runtime integration under injected gate**

Create prompt token/lifecycle before Bridge adds reaction via a `preparePrompt(messageContext): PreparedPrompt` factory shared by Bridge and ChatRuntime. `PreparedPrompt` owns the controller and acknowledgement callbacks; Bridge adds reaction then calls `prepared.attachAcknowledgement(reactionId?)` and enqueues that same prepared object. Default gate remains disabled.

- [ ] **Step 6: Verify and commit**

Run runtime + ACP tests, build, Prettier. Commit: `refactor(runtime): own cards per prompt lifecycle`.

---

### Task 11: Bridge Single-Writer Cutover and Stale Receipt Removal

**Files:**
- Modify: `src/bridge/bridge.ts`
- Modify: `src/bridge/chat-runtime.ts`
- Modify: `src/bridge/chat-runtime.test.ts`
- Modify: `src/bridge/bridge-card-lifecycle.test.ts`

**Interfaces:**
- Bridge strict parser accepts only exact v2 Cancel `{ v:2,c,th?,cancel:true,p,s,a }` and permission `{ v:2,c,th?,p,q,r,o }` schemas; version is checked before runtime lookup.
- ChatRuntime exposes:

```ts
consumeCancelAction(input: { promptToken: string; segmentToken: string; actionToken: string }): "accepted" | "stale" | "duplicate";
consumePermissionAction(input: { promptToken: string; permissionToken: string; requestId: string; optionId: string }): "accepted" | "stale" | "duplicate" | "invalid_option";
```

- Bridge passes decoded tokens/request/option into these methods. Controller verifies current token, request ID, allowed option membership, and one-shot consumption before ACP resolve/cancel.
- Produces complete v2 single-writer route when injected gate is true; production default remains false until Task 12 persistence/enablement.

- [ ] **Step 1: RED — no standalone receipt card and correct reaction lifetime**

For a normal short prompt, assert bridge adds a fixed receipt-only emoji reaction, never directly calls v2 conversation-card send/update, and the runtime creates one authoritative card. Remove the reaction only after the first authoritative send returns a visible card ID, or after terminal when no card was created. Cover first send throwing and returning null: no durable processing card exists and the reaction is removed at terminal. Reaction add/remove failure must not abort the prompt.

- [ ] **Step 2: RED — token-safe Cancel**

Current tokens cancel exactly once. Previous prompt, previous segment, duplicate, legacy tokenless, and unknown-version buttons do not cancel current work and are best-effort neutralized.

- [ ] **Step 3: RED — token-safe permission actions**

Current prompt+permission token resolves exactly once. Previous prompt, previous permission request, duplicate, legacy tokenless, and unknown-version permission actions never resolve the current ACP permission and are best-effort expired.

- [ ] **Step 4: RED — no direct conversation-card bypass**

A source-level assertion scans all `src/` production files and requires the exact temporary allowlist established in Task 10: presenter transport, legacy adapter, and lifecycle Delivery only. Bridge, ChatRuntime, and HummingClient are never file-level exceptions.

- [ ] **Step 5: Implement cutover code with gate defaulting off**

Switch the complete v2 route to reaction acknowledgement and lifecycle effects, remove v2 direct patches, but leave `features.conversationCardLifecycleV2` default false. Do not enable the persisted gate in this code commit.

- [ ] **Step 6: Verify and commit**

Run all bridge/runtime/ACP/presenter tests, full `npm test`, build, fmt check. Commit: `feat(cards): cut over to semantic lifecycle`.

---

### Task 12: Feature Gate, Schema Status, and Rollback-Safe CLI

**Files:**
- Modify: `templates/home/settings.back.json`
- Modify: `bin/humming.ts`
- Modify: `bin/humming.test.ts`
- Modify: `bin/process-control.ts`
- Modify: `bin/process-control.test.ts`
- Modify: `src/bridge/control-server.ts`
- Modify: `src/bridge/control-server.test.ts`

**Interfaces:**
- CLI commands are exact:
  - `humming cards-v2 enable`: query live control status; require `cardActionSchemaVersion >= 2`; persist gate true; restart/reload.
  - `humming cards-v2 disable`: persist and reread gate false; restart/reload current binary.
  - `humming cards-v2 rollback --checkout <absolute-path>`: verify the target checkout contains Task 1's guard marker/test and a built CLI; persist and reread gate false; stop current bridge; start the target checkout using its explicit binary plus the saved launch descriptor. Failure before stop leaves current bridge running; failure after stop reports loudly and does not re-enable gate.
- Persists `features.conversationCardLifecycleV2`, default false.
- Live status reports `cardActionSchemaVersion: 2` and effective gate state.

- [ ] **Step 1: RED — default-off and compatibility schema**

Assert missing setting means false; status reports schema 2; persisted true is effective only on a schema-2 binary; gate-off keeps legacy behavior.

- [ ] **Step 2: RED — deployment and rollback command ordering**

With fake process control, prove enable refuses unless the running bridge reports schema >= 2. Prove rollback validates the target contains commit/guard `4700e9d` behavior, then records calls in this exact order: `writeGate(false)`, `readGate() === false`, `stopCurrent()`, `startCheckout(target, launchDescriptor)`. Cover invalid target, persist/reread failure before stop, and target-start failure after stop.

- [ ] **Step 3: Implement configuration and CLI**

Add the minimal settings merge preserving unrelated keys. Gate remains false in templates and existing installations until an explicit command.

- [ ] **Step 4: Verify and commit**

Run CLI/control tests, full suite, build, and format. Commit: `feat(cards): add rollback-safe lifecycle gate`.

---

### Task 13: Gate-Off Deployment, Explicit Enablement, and Real Verification

**Files:**
- Tests may add focused regression fixtures only; no feature expansion.

- [ ] **Step 1: Run deterministic and full quality gates**

```bash
npm test
npm run build
npx tsc -p tsconfig.type-tests.json --noEmit
npm run fmt:check
git diff --check
```

Expected: all pass with no skipped tests or attributable warnings.

- [ ] **Step 2: Independent integration review**

Review one semantic writer, callback protocol attribution, action authority, terminal absorption, immutable snapshots, permission ownership, ToolLedger, receipt removal, schema gate, and rollback ordering. Fix/re-review before deployment.

- [ ] **Step 3: Deploy new binary with gate OFF**

Build and restart. Confirm linked checkout, bridge health, `cardActionSchemaVersion: 2`, and effective gate false. Exercise one legacy short prompt to prove gate-off behavior remains functional.

- [ ] **Step 4: Simulate rollback ordering while gate is off**

Run the actual `humming cards-v2 rollback --checkout <rollback-fixture-checkout>` against an isolated temporary home and disposable bridge fixture. Verify the fixture contains Task 1's guard, gate is reread false before stop, the target fixture binary starts, and the original development runtime is untouched. This is a real old-checkout process switch in isolation, not only a mock or dry-run.

- [ ] **Step 5: Explicitly enable v2 and restart/reload**

Use the new CLI operation, which refuses unless the running bridge reports schema 2. Verify status reports effective gate true after restart/reload.

- [ ] **Step 6: Real short-prompt verification with screenshot evidence**

Send one short prompt. Capture a screenshot showing transient acknowledgement/no stale receipt, exactly one authoritative final Humming card, and no terminal Cancel.

- [ ] **Step 7: Real deterministic long-prompt verification**

Use a controlled mock or prompt that emits more than 10,000 UTF-8 bytes plus multiple tool states, guaranteeing the 8192-byte rotation threshold is crossed. Capture screenshots proving historical cards have no header/footer/Cancel, exactly one current card is actionable, terminal cannot reopen, and no later Waiting appears.

- [ ] **Step 8: Stale action verification**

Click stale Cancel and stale permission fixtures. Verify the current prompt continues/current permission remains unresolved and logs contain bounded rejection diagnostics without sensitive values.

- [ ] **Step 9: Final status**

Confirm `git status --short` clean, local `HEAD == origin/main`, and `humming status` running with schema 2 and gate true.

---

### Deferred Post-Migration Cleanup (separate future plan)

After an explicit observation window and user approval, remove legacy `AgentStatus + cancellable` and gate-off adapter. The initial deployment keeps them for immediate rollback. Never remove Task 1's unknown-version action guard.
