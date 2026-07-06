# Feishu Scan Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `humming setup` so users can scan a Feishu/Lark QR code and automatically save bot credentials to `~/.humming/settings.json`.

**Architecture:** Put Feishu/Lark app-registration protocol code in `src/lark/registration.ts`. Keep Humming settings-file merge/write behavior in `bin/humming.ts` because it is CLI state management, not Lark transport. The CLI prints only masked identifiers and never prints App Secret.

**Tech Stack:** TypeScript strict mode, Node ≥20 global fetch, `qrcode-terminal` for terminal QR rendering, Vitest.

## Global Constraints

- User-visible product name is Humming Agent and CLI is `humming`.
- Do not print, log, or persist any secret outside `settings.json`.
- Preserve existing `runtime`, `agents`, and `bindings` fields when setup writes credentials.
- `settings.json` is chmodded `0600` best-effort after writes.
- Quality gates: `npm run fmt:check`, `npm run build`, `npm test`, `git diff --check`.

---

### Task 1: Registration Client

**Files:**

- Create: `src/lark/registration.ts`
- Test: `src/lark/registration.test.ts`

**Interfaces:**

- Produces: `initFeishuRegistration`, `beginFeishuRegistration`, `pollFeishuRegistration`, `runFeishuQrRegistration`, `renderQrToTerminal`.

- [x] Write failing tests for init/begin/poll/QR injection.
- [ ] Implement the registration protocol using injected transport plus default fetch transport.
- [ ] Run `npm test -- src/lark/registration.test.ts`.

### Task 2: CLI Setup Command

**Files:**

- Modify: `bin/humming.ts`
- Test: `bin/humming-setup.test.ts`

**Interfaces:**

- Consumes: registration client from Task 1.
- Produces: `humming setup`, `humming setup feishu`, `humming setup feishu --force`.

- [x] Write failing parser/settings/secret-redaction tests.
- [ ] Add parse support for setup commands.
- [ ] Add atomic settings credential writer and masked success summary.
- [ ] Add `runSetup` that refuses overwrite unless `--force`, runs registration, probes bot, writes credentials, and prints next-step guidance.
- [ ] Run setup-related tests.

### Task 3: Docs, Dependencies, Verification

**Files:**

- Modify: `package.json`, `package-lock.json`, `README.md`, `templates/home/settings.back.json`

- [ ] Add `qrcode-terminal` runtime dependency and `@types/qrcode-terminal` dev dependency.
- [ ] Document `humming setup` in README and template comments/examples.
- [ ] Run full gates and fix issues.
- [ ] Commit, push, restart Humming.
