# humming operating guide

Use this guide when the user asks to configure Humming, bind/rebind a repo, bind this topic to an existing agent session, switch Agent, or change Model/Mode/Permission/Config controls.

## Files

- Settings: `{{SETTINGS_PATH}}`
- Sessions: `{{SESSIONS_PATH}}`
- Control socket: `{{CONTROL_SOCKET_PATH}}`
- Settings example: `{{SETTINGS_EXAMPLE_PATH}}`
- Sessions example: `{{SESSIONS_EXAMPLE_PATH}}`

Do not print secrets, full chat IDs, full thread IDs, full session IDs, tokens, API keys, or connection strings in group chats.

## Settings contents

`settings.json` stores machine/global configuration:

- `credentials`: Feishu/Lark bot app credentials. Do not print them.
- `runtime.agent`: global default Agent for new chats/topics with no inherited profile.
- `runtime.defaultControls`: global default Model / Mode / Permission / Config controls for new chats/topics with no inherited profile.
- `runtime.permissionMode`: global Humming approval-card policy.
- `runtime.lifecycleNotifyChatIds`: chats that receive bridge lifecycle notifications.
- `runtime.globalControlChatIds`: DM control chats whose Agent/Model/Mode/Permission/Config changes write global defaults back to `settings.json`.
- `runtime.cwd` / `runtime.unboundCwd`: default/reception working directories.
- `agents`: built-in preset overrides and custom Agent presets.
- `bindings`: per-chat repo bindings only: `{ "cwd": "/absolute/path/to/repo" }`.

Do not store per-topic session state in `settings.json`; that belongs in `sessions.json`.

## Built-in commands handled by Humming

If the user sends one of these slash commands, do not reinterpret it; Humming handles it before the Agent sees it:

```text
/help
/commands
/capabilities
/capabilities <agent>
/agent
/agent <agent>
/model
/model <model-id|auto>
/mode
/mode <mode-id>
/permission
/permission <alwaysAsk|alwaysAllow|alwaysDeny>
/profile
/bind <path>
/where
/unbind
/new
/cancel
```

`/model auto` means clear the explicit model override.

## General Humming CLI rules

- Humming injects `HUMMING_CHAT_ID` and `HUMMING_THREAD_ID` into Agent subprocesses. Omit `--chat-id` / `--thread-id` unless intentionally targeting a different chat/topic.
- Use Humming CLI/control commands for Agent/session state. Do not inspect Claude/Codex/Gemini/OpenCode cache directories or guess from project files.
- Chat binding is repo-only. Do not put Agent/Model/Mode/Permission/Config into `bindings`.
- Direct-message global-control chats update global defaults; group/topic changes are session-scoped.

Useful commands:

```bash
humming agents
humming control capabilities --json
humming control agent-capabilities --agent <agent> --json
humming sessions list --agent <agent> --json
```

## Repo binding

When the user asks to bind/rebind a chat to a repo, preserve unrelated `settings.json` keys and write only:

```json
{
  "bindings": {
    "<chatId>": { "cwd": "/absolute/path/to/repo" }
  }
}
```

After editing settings, let Humming send the normal repo-bound notice.

## Session controls: Model / Mode / Permission / Config

Before changing controls, query capabilities:

```bash
humming control capabilities --json
```

Use only IDs/values returned by capabilities. If the requested value is unavailable, tell the user and do not write controls.

For another Agent's controls before switching, probe it:

```bash
humming control agent-capabilities --agent <agent> --json
```

If the probe fails, stop. Do not switch Agent or write controls.

Set controls with split flags:

```bash
humming sessions set-control --model <model-id>
humming sessions set-control --model auto
humming sessions set-control --mode <mode-id>
humming sessions set-control --permission alwaysAsk
humming sessions set-control --config <select-config-id>=<value-id>
humming sessions set-control --bool-config <boolean-config-id>=true
```

Combine flags when changing multiple controls:

```bash
humming sessions set-control --model <model-id> --mode <mode-id> --permission alwaysAsk
```

Use JSON only for complex/bulk config updates, preferably via file or stdin:

```bash
humming sessions set-control --json-file /absolute/path/to/controls.json
humming sessions set-control --json-stdin < /absolute/path/to/controls.json
```

If the same user request includes a task to run after the controls apply, queue the task after `set-control` succeeds:

```bash
humming sessions queue-task --prompt-file /absolute/path/to/task.md
humming sessions queue-task -- "short task text"
```

Do not call `queue-task` when there is no task.

## Agent switching / natural-language handoff

For a pure Agent switch with no task and no controls:

```bash
humming sessions set-agent --agent <agent>
```

For a single user request that contains Agent switch + controls and/or task, use exactly one pending target profile command:

```bash
humming sessions set-pending-target-profile --agent <agent> \
  --model <model-id> \
  --mode <mode-id> \
  --permission alwaysAsk \
  --prompt-file /absolute/path/to/task.md
```

Short task form:

```bash
humming sessions set-pending-target-profile --agent <agent> --model gpt-5.5 -- "task text"
```

Rules:

- `set-pending-target-profile` requires `--agent`.
- For Model/Mode/Permission/Config-only changes, use `humming sessions set-control`, even if an Agent switch is already pending.
- Do not split one handoff into `set-agent` + `set-control` + `queue-task` unless `set-pending-target-profile` is unavailable.
- Do not add `--cwd` to `set-agent` or `set-pending-target-profile`.
- Do not edit `runtime.agent` or `bindings` to switch the current topic's Agent.
- Do not explain Humming internals to the user; run the command and continue the task.

## Binding this topic to an existing agent session

List sessions for the current chat repo:

```bash
humming sessions list --agent claude --json
```

List sessions for an explicitly requested repo only for inspection:

```bash
humming sessions list --agent codex --cwd /absolute/path/to/repo --json
```

Bind the current topic to a selected session in the current chat repo:

```bash
humming sessions bind --agent claude --session-id "<selected-session-id>"
```

Rules:

- Do not hand-edit `sessions.json`.
- Do not pass `--cwd` to `sessions bind`.
- If the session is already bound elsewhere, ask the user to reset the original thread first.
- If multiple sessions match, show short candidates and ask the user to choose.

## Permission controls

- If the Agent exposes Plan/Edit/Bypass as modes, set `modeId`.
- If the Agent exposes approval/bypass as config, set `config`.
- Use `bridgePermissionMode` only for Humming's approval-card policy.
