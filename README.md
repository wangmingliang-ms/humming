# feishu-acp

Bridge Feishu/Lark to any ACP-compatible AI agent — run coding agents from your phone.

## What it does

Send a message to your Feishu bot → it forwards to a local ACP agent (Copilot, Claude, Codex, etc.) → reply comes back to Feishu.

Your agent runs **locally** or on **your own server**. No cloud required.

---

## User quick start

```sh
npx feishu-acp --agent copilot
```

First run launches an interactive setup that creates your Feishu app automatically via `lark-cli`.

---

## Development workflow

### Prerequisites

- Node.js ≥ 20
- npm ≥ 9

### 1. Clone and install

```sh
git clone https://github.com/JiaqiZhang-Dev/feishu-acp.git
cd feishu-acp
npm install
```

`@larksuite/cli` is a direct dependency — `lark-cli` is available in `node_modules/.bin` after install, no global install needed.

### 2. Build

```sh
npm run build        # one-time compile (TypeScript → dist/)
npm run dev          # watch mode — recompiles on save
```

Output goes to `dist/`. The CLI entry is `dist/bin/feishu-acp.js`.

### 3. First-time Feishu setup

```sh
node dist/bin/feishu-acp.js setup
```

This runs `lark-cli config init --new` (opens browser OAuth to create your Feishu app), then `lark-cli config bind --source lark-channel` which writes credentials to `~/.lark-channel/config.json`.

> **Manual fallback:** If you prefer to create the app yourself, answer `n` at the prompt and enter your App ID and App Secret directly. See [manual setup](#manual-feishu-app-setup) below.

### 4. Run the bridge

```sh
node dist/bin/feishu-acp.js --agent copilot
node dist/bin/feishu-acp.js --agent claude --cwd /path/to/project
node dist/bin/feishu-acp.js --agent "opencode acp"
```

### 5. Re-run setup (rotate credentials, switch app)

```sh
node dist/bin/feishu-acp.js setup
# then restart the bridge
node dist/bin/feishu-acp.js --agent copilot
```

### Credential resolution order

On every start, feishu-acp looks for credentials in this order:

1. `~/.lark-channel/config.json` — written by `lark-cli config bind --source lark-channel`
2. `~/.feishu-acp/config.json` — written by manual setup
3. Interactive setup prompt (first run)

---

## Manual Feishu app setup

If you prefer to create the app yourself:

1. Go to [Feishu Open Platform](https://open.feishu.cn/app) → **Create self-built app**
2. Add **Bot** capability
3. Grant permissions: `im:message`, `im:message:send_as_bot`, `im:message.react:create`
4. Subscribe to event `im.message.receive_v1` using **long connection** (no public endpoint needed)
5. Publish the app and add the bot to yourself

Then run `node dist/bin/feishu-acp.js setup`, answer `n` to the lark-cli prompt, and enter your App ID and App Secret.

---

## Supported agents

| Preset     | Agent                |
|------------|----------------------|
| `copilot`  | GitHub Copilot CLI   |
| `claude`   | Claude Code          |
| `codex`    | OpenAI Codex CLI     |
| `gemini`   | Google Gemini CLI    |
| `opencode` | OpenCode             |

```sh
# List all presets
node dist/bin/feishu-acp.js agents
```

---

## CLI reference

```
node dist/bin/feishu-acp.js --agent <preset|command>  [options]
node dist/bin/feishu-acp.js setup
node dist/bin/feishu-acp.js agents

Options:
  --agent <value>        Built-in preset or raw ACP command (required)
  --cwd <dir>            Working directory for the agent (default: cwd)
  --setup                Re-run credential setup before starting
  --idle-timeout <min>   Session idle timeout in minutes (default: 1440)
  --max-sessions <n>     Max concurrent user sessions (default: 10)
  --hide-thoughts        Don't forward agent reasoning to Feishu
  -h, --help             Show help
  -v, --version          Show version
```

---

## Project structure

```
feishu-acp/
├── src/
│   ├── config.ts              # Config types, agent presets, credential loading
│   ├── bridge.ts              # Main orchestrator (Feishu ↔ ACP)
│   ├── feishu/
│   │   ├── client.ts          # Feishu HTTP API (reply, react)
│   │   ├── websocket.ts       # WebSocket long connection
│   │   ├── setup.ts           # Interactive first-run setup + lark-cli integration
│   │   └── types.ts           # Feishu event types
│   ├── acp/
│   │   ├── agent-manager.ts   # Spawn agent subprocess, create ACP session
│   │   ├── client.ts          # ACP client (chunk accumulator, permission handler)
│   │   └── session.ts         # Per-user session queue, LRU eviction
│   └── adapter/
│       ├── inbound.ts         # Feishu message → ACP ContentBlock[]
│       └── outbound.ts        # ACP response → Feishu text (4000-char splitter)
├── bin/
│   └── feishu-acp.ts          # CLI entry point
├── dist/                      # Compiled output (git-ignored)
└── package.json
```

---

## License

MIT
