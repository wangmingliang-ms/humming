# Conversation Card Lifecycle — Canonical Specification

**Status:** Normative source of truth
**Date:** 2026-07-12

This document defines the product semantics for conversation cards. Implementation plans, reducers, routers, delivery code, tests, and older dated design documents are subordinate to this specification. If a new case changes these semantics, update and review this document first; only then change code and tests.

## 1. Domain model

```text
Topic
└── Turn[]
    ├── Request
    └── Response
        └── Card[] (ordered)
```

- A **Turn** is exactly one user `Request` plus its corresponding `Response`.
- A **Response** may be rendered as multiple ordered Cards because content is too long, waiting lasts too long, a permission boundary is crossed, or the current Card must be replaced.
- Every Response with a visible Card has exactly one **tail Card**: the last Card in that Response.
- Every earlier Card in that Response is an **intermediate Card**.
- A Card is only a projection of its Response. Card-local state must never independently decide execution ownership or lifecycle.

## 2. Topic execution ownership

A Topic has at most one **Execution Owner Response**.

```ts
type Topic = {
  turns: Turn[];
  executionOwnerResponseId: ResponseId | null;
};
```

Execution ownership answers only this question:

> Which Response currently owns the Agent execution slot for this Topic?

The newest Turn is not necessarily the Execution Owner. During an interrupt handoff, the new Turn already exists while the previous Response still owns execution until that previous Response is sealed as terminal.

Ownership handoff is always:

```text
old Response -> no owner -> new Response
```

It must never be:

```text
old Response -> old and new Responses simultaneously -> new Response
```

## 3. Response phases

The product-level Response phases are:

```text
received / queued
interrupting
preparing
active
terminal:
  - complete
  - failed
  - interrupted
  - cancelled
```

Implementation-only substates may exist, but they must not change the rules in this document.

- `received / queued`: accepted but not taking over execution.
- `interrupting`: this Response is waiting for the current Execution Owner to terminate.
- `preparing`: the previous owner is terminal; this Response is preparing to execute.
- `active`: this Response is the Execution Owner and the Agent is executing it.
- `terminal`: the Response has ended and can never become active again.

## 4. Universal Card projection rules

Let:

```ts
const isTail = card.id === response.tailCardId;
```

Then the canonical projection is:

```ts
showTitle = isTail;
showMetadata = isTail;
showCancel =
  isTail && response.phase === "active" && topic.executionOwnerResponseId === response.id;
```

### 4.1 Intermediate Card

Every intermediate Card in a Response is an immutable content artifact:

```text
Title: hidden
Metadata: hidden
Cancel: hidden
Other execution actions: hidden
Content: retained
```

This rule is independent of why the successor Card was created.

### 4.2 Tail Card while non-terminal

The tail Card retains Title and Metadata in all non-terminal phases:

| Response phase              | Title | Metadata | Cancel |
| --------------------------- | ----: | -------: | -----: |
| received / queued           |   yes |      yes |     no |
| interrupting                |   yes |      yes |     no |
| preparing                   |   yes |      yes |     no |
| active, not Execution Owner |   yes |      yes |     no |
| active, Execution Owner     |   yes |      yes |    yes |

`active, not Execution Owner` should normally be unreachable. If observed, it is an invariant violation and must not render Cancel.

### 4.3 Tail Card after Response termination

The final tail Card retains Title and Metadata for every terminal outcome:

| Outcome     |                                       Title | Metadata | Cancel |
| ----------- | ------------------------------------------: | -------: | -----: |
| complete    |           retained as successful completion | retained |     no |
| failed      |                   retained as failure/error | retained |     no |
| interrupted | retained as interrupted/neutral error state | retained |     no |
| cancelled   |         retained as cancelled/neutral state | retained |     no |

A terminal tail is the final status of the Response. It must not be stripped into a plain content Card.

### 4.4 Consequence

For one Response containing Cards `C1, C2, ..., Cn`:

```text
C1 ... C(n-1): no Title, no Metadata, no actions
Cn: Title and Metadata retained
Cn has Cancel only while its Response is active and owns execution
```

## 5. When a Card is created

### 5.1 First Card of a Response

Create or adopt one lifecycle-owned Card when a Request is accepted as a Response.

- If the Topic is idle, that Card moves in place through `received -> preparing -> active -> terminal`.
- If another Response owns execution, that Card moves in place through `received -> interrupting -> preparing -> active -> terminal`.
- Do not create a standalone durable receipt Card and then create a second task Card for the same Response.
- A transient acknowledgement Reaction may exist before the first authoritative Card is visible, but it is not a Card and owns no action.

### 5.2 Additional Card in the same Response

Create a successor Card only when the same Response requires a new visual segment, for example:

- content length rotation;
- waiting-time/idle rotation;
- permission boundary and continuation;
- transport replacement after the current Card can no longer be patched.

The tail handoff is atomic at the semantic layer:

```text
1. Revoke the old tail's action.
2. Make the old tail intermediate:
   - hide Title;
   - hide Metadata;
   - hide all actions.
3. Create/adopt the successor as the new tail.
4. Render Title and Metadata on the new tail.
5. Render Cancel on the new tail only if the Response is active and is Execution Owner.
```

There must never be an interval in semantic state where both old and new tails are actionable. Transport may complete asynchronously, but stale action tokens must already be invalid.

## 6. Normal idle-to-complete branch

```text
Topic has no Execution Owner
  -> Request A accepted
  -> Response A created
  -> A tail: received/preparing, no Cancel
  -> executionOwner = A
  -> A active
  -> A tail: Title + Metadata + Cancel
  -> A complete/failed/cancelled
  -> executionOwner = null
  -> A final tail: terminal Title + Metadata, no Cancel
```

If A rotates from `A1` to `A2` while active:

```text
A1 -> intermediate: no Title, no Metadata, no Cancel
A2 -> tail: Title + Metadata + Cancel
```

When A ends, `A2` remains the final tail with terminal Title and Metadata and without Cancel.

## 7. New Request while another Response is active

Suppose Response A is active and owns execution. Request B arrives.

### 7.1 B is accepted immediately

Create/adopt B's first Card immediately and show:

```text
Response B: interrupting
B tail: "message received; interrupting the current Response"
Title: yes
Metadata: yes
Cancel: no
```

At this moment A has not ended:

```text
Response A: active, Execution Owner
A tail: Title + Metadata + Cancel
Response B: interrupting, not owner
B tail: Title + Metadata, no Cancel
```

This temporary two-Card view is legal. Two Cancel buttons are never legal.

### 7.2 Interrupt A

Request interruption of A. Until interruption is confirmed and A is sealed:

- A remains Execution Owner.
- A may retain Cancel on its tail.
- B remains `interrupting` and has no Cancel.
- Agent output from A must only update A.
- B must not receive A's callbacks or become active early.

### 7.3 Seal A, then release ownership

When A's interruption is confirmed:

```text
1. Close A's callback route.
2. Revoke A's action token.
3. Set A terminal outcome to interrupted.
4. Update A's final tail:
   - keep interrupted Title;
   - keep Metadata;
   - remove Cancel.
5. Set executionOwner = null.
```

Late A callbacks are ignored and must never restore a running Title or Cancel.

### 7.4 Start B using the same Card

Do not create another B task Card. Update B's existing tail in place:

```text
B interrupting -> B preparing
B tail: Title + Metadata, no Cancel

executionOwner = B
B preparing -> B active
B tail: Title + Metadata + Cancel
```

The legal ownership sequence is therefore:

```text
A active / B interrupting:
  Cancel owner = A

A interrupted / B preparing:
  Cancel owner = nobody

A interrupted / B active:
  Cancel owner = B
```

### 7.5 Additional Requests during handoff

If C arrives while B is interrupting A, C may have a received/queued tail Card, but it has no Cancel and no execution ownership. The scheduling policy for B and C is separate from Card projection. Regardless of scheduling policy:

- only the current Execution Owner's active tail may show Cancel;
- waiting Responses never show Cancel;
- a Response cannot receive Agent callbacks before it owns execution.

## 8. Permission boundary

Permission UI is a separate actionable artifact, but the same exclusivity rule applies:

```text
1. Revoke Cancel from the active Response tail.
2. If a successor Response Card is created, the old tail becomes intermediate.
3. Present the permission action as the only actionable artifact.
4. Resolve/expire the permission action exactly once.
5. Resume with a new Response tail segment.
6. Restore Cancel only when that tail is active and its Response owns execution.
```

At most one actionable artifact exists for a Topic.

## 9. Cancellation, failure, disconnect, and late callbacks

All terminal paths use one sealing operation:

```text
1. Close the Response callback route.
2. Revoke its action token.
3. Mark running tools terminal as appropriate.
4. Set terminal outcome.
5. Update only its final tail:
   - retain terminal Title;
   - retain Metadata;
   - remove Cancel.
6. Reject all later renderable callbacks.
```

An old Card's stale visual button must be harmless because its action token has been revoked. An unversioned/tokenless legacy Cancel must never cancel a newer Response.

## 10. Restart semantics

Restart is intentionally simple and non-durable.

- When restart begins, the current Execution Owner Response is sealed as `interrupted`; its final tail keeps Title and Metadata and loses Cancel.
- Waiting Responses may be abandoned/interrupted without replay.
- Messages arriving during the restart window may be dropped.
- If the old process is still alive and chooses to reply, it may send a non-actionable informational notice saying Humming is restarting and the user should resend later.
- If no process is alive, no response is possible.
- Do not persist, compensate, recover, or replay restart-window Requests.
- A restart notice is not a task Response Card and never has Cancel.

## 11. Compaction and rotation wording

Rotation and content compaction are separate concerns.

- Rotating a Response creates a new tail and demotes the previous tail to an intermediate Card according to Section 5.2.
- Compaction copy must describe what was actually compacted:
  - response text -> earlier response content;
  - tool entries -> earlier tool activity;
  - thought entries -> earlier thought activity.
- Tool/thought activity must not be described as hidden response text.
- Compaction must never create another Execution Owner or another actionable Card.

## 12. Required invariants

These invariants are mandatory in production and tests:

```text
I1. Every visible Response has exactly one tail Card.
I2. Only a Response tail displays Title and Metadata.
I3. Intermediate Cards display no Title, Metadata, or actions.
I4. A Topic has at most one Execution Owner Response.
I5. Only an active Execution Owner's tail displays Cancel.
I6. Therefore a Topic has at most one Cancel button in semantic state.
I7. Terminal Responses never accept renderable callbacks.
I8. Ownership handoff is old -> none -> new, never overlapping.
I9. A new Request's interrupting Card is reused for preparing/active; no duplicate task Card.
I10. Terminal final tails retain Title and Metadata for success, failure, interruption, and cancellation.
```

## 13. Conformance matrix

| Situation                | Previous Response tail                  | New Response tail                   | Cancel owner                   |
| ------------------------ | --------------------------------------- | ----------------------------------- | ------------------------------ |
| Idle Request accepted    | none                                    | received/preparing                  | none                           |
| Response active          | active Title + Metadata                 | none                                | active Response                |
| New Request arrives      | A active Title + Metadata               | B interrupting Title + Metadata     | A only                         |
| A interruption confirmed | A interrupted Title + Metadata          | B preparing Title + Metadata        | none                           |
| B starts                 | A interrupted Title + Metadata          | B active Title + Metadata           | B only                         |
| Same Response rotates    | old tail becomes plain intermediate     | successor tail Title + Metadata     | successor only if owner active |
| Response completes       | final tail complete Title + Metadata    | none                                | none                           |
| Response fails           | final tail failed Title + Metadata      | none                                | none                           |
| Response is cancelled    | final tail cancelled Title + Metadata   | none                                | none                           |
| Bridge restarts          | final tail interrupted Title + Metadata | optional non-actionable notice only | none                           |
| Late callback arrives    | no change                               | no new Card                         | none                           |

## 14. Change-control rule

This specification is changed before implementation.

For every newly discovered lifecycle case:

1. Add or modify the branch and conformance row in this document.
2. Review the resulting ownership, tail, Title, Metadata, and Cancel behavior.
3. Add failing tests directly from the normative row/invariant.
4. Change the implementation through the single lifecycle writer.
5. Verify the real Feishu path, not only reducer/unit tests.

No implementation patch may introduce a new Card lifecycle branch that is absent from this specification. If implementation details conflict with this document, this document wins until it is explicitly revised.
