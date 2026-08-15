# Codex ACP Package Migration Design

## Goal

Migrate Humming's built-in Codex preset to the maintained
`@agentclientprotocol/codex-acp` package and remove deprecated vendor-scope references.

Every newly created Codex session must launch through:

```text
npx -y @agentclientprotocol/codex-acp
```

## Scope

- Update the built-in Codex agent preset and its description.
- Update documentation and current-package test fixtures.
- Add an exact preset contract test for the new package invocation.
- Verify that the maintained adapter can initialize a new session and process a real request.
- Build and restart the Humming Gateway so subsequent sessions use the new preset.

## Out of Scope

- Do not rewrite persisted invocations for existing sessions.
- Do not migrate existing Codex session IDs or stored controls.
- Do not add legacy mode mappings.
- Do not add the adapter to Humming's `package.json`; adapters remain dynamically launched with
  `npx -y` under the existing architecture.
- Do not rewrite explicitly configured custom/raw agent commands.

## Implementation

Update `bin/agents.ts` so the `codex` built-in preset references the maintained package. Keep the
existing `npx -y` launch shape because the maintained package documents this invocation and exposes
the same `codex-acp` executable role.

Update README language and test data that represent the current built-in Codex preset. Historical or
purpose-built legacy fixtures may retain the old package only when they explicitly test legacy
behavior; this migration does not add such behavior.

## Error Handling

The existing ACP process startup and authentication error handling remains responsible for package
startup, missing authentication, and request failures. This migration does not introduce a second
adapter-specific error path.

A failed real-adapter smoke test blocks completion. The failure must be reported with its observed
stage: package launch, ACP initialization, session creation, authentication, or request processing.

## Testing and Verification

1. Add the exact Codex preset assertion before changing production code and verify that it fails.
2. Update the preset, README, and current-package fixtures; rerun the focused test and verify it
   passes.
3. Run the project test suite.
4. Run the CI-equivalent checks:
   - `tsc --noEmit`
   - ESLint
   - Prettier check
5. Build the project.
6. Launch the maintained adapter and perform a real smoke test that:
   - initializes ACP;
   - creates a new Codex session;
   - sends a prompt;
   - receives a successful agent response.
7. Restart the Gateway and verify its status/logs. Confirm a fresh Codex probe resolves to
   `@agentclientprotocol/codex-acp`.

The existing untracked incident document is unrelated and must remain untouched.
