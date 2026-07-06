# `humming update` — Design

Date: 2026-07-06

## Problem

Today the install scripts (`install.sh` / `install.ps1`) clone the repo into a
**temp dir**, `npm install`, `npm run build`, `npm install -g --install-links .`
(a _copy_, not a symlink), then delete the temp dir. That works for a one-shot
install, but there is no persistent checkout on the machine, so **upgrading means
re-running the whole install one-liner**. There is no `humming update`.

We want a persistent, machine-managed checkout plus a first-class
`humming update` that keeps the local `main` in lockstep with GitHub `main`,
rebuilds, and (if the bridge is running) restarts it automatically.

## Goals

- Persistent managed checkout at a well-known path under the humming home.
- `humming update`: hard-sync local `main` → `origin/main`, reinstall deps,
  rebuild, refresh the global command, and auto-restart a running bridge.
- After update, the global `humming` reflects the new build with no reinstall.
- Auto-restart must preserve the **original launch arguments** (e.g.
  `--agent codex`), not silently drop them.
- Clear, actionable errors; a failed update never takes down a running bridge.

## Non-goals (YAGNI)

- Backward-compat / self-heal for machines installed with the **old** temp-dir
  script. Out of scope by explicit decision — `update` targets the new layout
  only; a missing managed checkout is a hard error (see below).
- Version comparison, `--check`, changelog display, rollback.
- Scheduled / automatic background updates.
- A `git pull` merge path or `--keep-local`. The managed checkout is a pure
  machine-owned artifact and is **always** hard-synced to `origin/main`.
- Switching branches/tags at update time beyond the `HUMMING_REF` override.

## Configuration

Same override knobs as the install scripts, read from the environment:

| Variable       | Default                    | Meaning                                  |
| -------------- | -------------------------- | ---------------------------------------- |
| `HUMMING_REPO` | `wangmingliang-ms/humming` | GitHub `owner/repo` (used only at clone) |
| `HUMMING_REF`  | `main`                     | git branch synced by `update`            |

Note: once the managed checkout exists, its `origin` remote already records the
repo URL, so `update` does not need `HUMMING_REPO` — it fetches whatever
`origin` points at. `HUMMING_REF` selects which branch to hard-sync (default
`main`).

## Managed checkout location

```
<home>/humming-project
```

where `<home>` follows the existing precedence in `humming.ts`
(`--home` → `$HUMMING_HOME` → `~/.humming`). So the default is
`~/.humming/humming-project`. Everything humming owns already lives under
`<home>` (settings.json, sessions.json, logs); the checkout joins them.

## Install-script changes (persistent clone + `npm link`)

Both `install.sh` and `install.ps1` change from temp-dir to persistent:

1. Resolve the managed checkout dir `<home>/humming-project`.
2. If it does not exist: `git clone https://github.com/$HUMMING_REPO.git` into it
   at branch `$HUMMING_REF`. If it already exists: `git fetch origin` +
   `git checkout -f $HUMMING_REF` + `git reset --hard origin/$HUMMING_REF`
   (idempotent re-install, same sequence as `update` step 2).
3. `npm install` in the checkout.
4. `npm run build`.
5. **`npm link`** (instead of `npm install -g --install-links .`) so the global
   `humming` bin **symlinks** into the managed checkout's `dist/`. Rebuilding the
   checkout is then immediately reflected in the global command — which is what
   makes `humming update` work without a reinstall.
6. `node dist/bin/humming.js init` (unchanged — seed home templates).

The temp-dir + `trap`/`finally` cleanup logic is removed. The home dir must be
computed in shell/PowerShell the same way the CLI does (honor `$HUMMING_HOME`,
else `~/.humming`); `--home` is a CLI-only concept and not honored by the
install scripts (documented).

## New subcommand: `humming update`

Wired into the existing `command` union + dispatch `switch` in `bin/humming.ts`,
with helpers in `bin/process-control.ts`. Cross-platform (no shell-only
constructs); git/npm are invoked via `spawnSync` with inherited stdio so the
user sees live progress.

Flow:

1. **Locate** the managed checkout `<home>/humming-project`.
   - **If it does not exist → hard error**, non-zero exit, message telling the
     user to re-run the install script. No clone, no self-heal.
2. **Hard-sync `main`:** `git fetch origin`, then `git checkout -f $HUMMING_REF`
   (default `main`), then `git reset --hard origin/$HUMMING_REF`. `fetch` runs
   first so an overridden `HUMMING_REF` that is not yet a local branch can still
   be checked out (git DWIM auto-creates a tracking branch from `origin/<ref>`);
   `checkout -f` guarantees we land on the target branch even if the checkout was
   left detached or the worktree was dirtied, matching the "always hard-synced,
   machine-owned artifact" invariant.
3. **Reinstall + rebuild:** `npm install` then `npm run build`, run _in_ the
   checkout dir.
4. **Refresh global command:** `npm link` (idempotent — ensures the global bin
   still points at this checkout).
5. **Auto-restart:** read `<home>/bridge.launch.json` (see below) to learn the
   original launch argv.
   - If a bridge is running → `stopBridge` then `startBridge` with the exact
     persisted argv.
   - If not running → skip restart, print a hint (`humming start` to launch).
   - If the launch file is missing/unreadable while a bridge **is** running →
     hard error telling the user to `humming restart` manually, rather than
     guessing arguments.

Ordering guarantees the running bridge is only touched **after** git+build
succeed, so a failed update leaves the old bridge untouched.

## Preserving launch arguments: `bridge.launch.json`

**Problem:** `runRestart` currently rebuilds `spawnArgv` from the argv the user
typed _on the restart command_ (`rawArgv` + `subcommandIndex` →
`rewriteSubcommand(... "proxy")`). An `update`-triggered restart has no such
argv, so `--agent` and other flags would be lost.

**Fix:** when `start` / `restart` launch the bridge, persist the resolved
`spawnArgv` to `<home>/bridge.launch.json`:

```jsonc
{
  "spawnArgv": ["proxy", "--agent", "codex"],
  "workingDirectory": "/home/user/some/repo",
  "savedAt": "2026-07-06T12:34:56.000Z",
}
```

`update`'s restart reads this file and reuses `spawnArgv` + `workingDirectory`
verbatim. Schema is validated with a small guard (shape-check, not `as`);
`savedAt` is informational.

Bonus: a bare `humming restart` (no flags) can also fall back to this file, so
restart no longer forgets `--agent`. That fallback is in scope because it shares
the same read path; the write already happens on every `start`/`restart`.

## Components touched

| File                     | Change                                                                                                                                                                              |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bin/humming.ts`         | `command` union + dispatch add `"update"`; `runUpdate()`; help text; persist launch argv on start/restart; read it in restart/update.                                               |
| `bin/process-control.ts` | `managedCheckoutDir(home)`, `bridgeLaunchPath(home)`, `persistLaunchArgv()`, `readLaunchArgv()`, and `runGit`/`runNpm` spawn helpers with a typed `ProcessControlError` on failure. |
| `install.sh`             | Temp-dir → persistent `<home>/humming-project`; `npm link`.                                                                                                                         |
| `install.ps1`            | Same, in PowerShell.                                                                                                                                                                |
| `README.md`              | Document `humming update` and the managed checkout.                                                                                                                                 |

## Error handling

- Missing managed checkout → `ProcessControlError`, non-zero exit, remedy
  (re-run install).
- `git` / `npm` not on PATH, or any git/npm/build step exiting non-zero →
  abort with the failing stage named; the running bridge is left alone.
- Errors are typed (`ProcessControlError` / `CliError`), never swallowed;
  original `cause` preserved when wrapping.
- All failure branches happen **before** the stop/start, upholding "a failed
  update never kills a running bridge".

## Testing

Unit (vitest, colocated `*.test.ts`), pure/injectable logic only:

- argv parsing accepts `update` and rejects stray options.
- `bridge.launch.json` round-trip: `persistLaunchArgv` → `readLaunchArgv`
  returns the same argv; malformed JSON → typed error, not a throw-through.
- path helpers (`managedCheckoutDir`, `bridgeLaunchPath`) honor `--home` /
  `$HUMMING_HOME`.
- "missing checkout" and "running bridge + missing launch file" decision
  branches return the expected error (git/npm/process calls injected as fakes).

Manual E2E (documented, not automated — touches the real global install):

- From a managed-checkout machine: `humming update` with the bridge **stopped**
  → syncs, rebuilds, prints the start hint.
- With the bridge **running under `--agent <x>`** → `humming update` restarts it
  and `humming status` + `logs` confirm the same agent and `WebSocket connected`.
- On a machine with no `<home>/humming-project` → `humming update` errors with
  the re-install remedy and exits non-zero.

## Invocation

```sh
humming update
HUMMING_REF=some-branch humming update   # sync a non-default branch
```
