# Session 历史回放（Replay）设计

## 目标

把一个已存在的 ACP Session 的历史对话，在当前 Feishu topic/thread 里重新渲染一遍，让新 topic 能看到这个 session 之前聊了什么。

三个入口，共用同一回放内核：

1. **`/replay`（Feishu slash command）** —— 手动回放**当前 topic 已绑定**的 session。主入口。
2. **`session bind --replay`（CLI flag）** —— 绑定到某个已有 session 时顺带回放。
3. **自然语言映射** —— 用户说“绑定 Session 并且重放历史”时，助手自动执行 `session bind --session-id <id> --replay`。

## 背景（现状机制）

- **绑定的本质**：`session bind` 只是把 `sessions.json` 里 `(chatId, threadId) → sessionId` 的指针切换，并 supersede 当前 runtime；下一条消息才 lazily 启动 agent 并 resume。绑定本身不拉取任何历史。
- **历史不落本地**：`SessionRecord` 只存元数据（ids、title、controls、时间戳），没有 transcript。`ListedAgentSession` 也只有 `sessionId/cwd/title/updatedAt`，没有消息。
- **唯一的历史来源是 ACP `session/load`**：`loadSession` 会把过往对话以一串 `session/update` 通知流式回吐。而 `unstable_resumeSession` 不会流历史。
- **当前 bootstrap 丢弃历史**：`chat-runtime.ts` bootstrap 的 `sessionUpdate` 回调只处理 `session_info_update`，其它 message/thought/tool chunk 全部丢弃（`chat-runtime.ts:993-996`）。
- **resume 优先级问题**：`spawnAndResumeAgent` / `spawnAndStrictlyResumeAgent` 在 agent 同时支持 resume+load 时**优先走 resume**（`agent-process.ts:397-424, 506-530`），而 resume 不流历史。**所以回放必须强制走 load 路径**，不能复用默认 spawn 的优先级。

## 决策记录

- **触发**：显式触发（flag / slash command），默认不回放，保持现状行为。
- **呈现内容**：只回放 **用户输入 + agent 最终文本回复**；跳过 `agent_thought_chunk` 和 tool call。
- **卡片布局**：每个历史 turn 独立成一个 Response，交给现有卡片预算管线渲染——短 turn 一张卡，长 turn 由 `conversationCardBudget`（20KB / 40 元素上限、`splitText` UTF-8 断行）自动溢出成多张。不手写切分，不强制合并。“卡片越少越好”由预算自然达成。
- **能力 fail-fast**：显式要求回放但 agent 不支持 `loadSession`（仅 resume）→ 报错/notice，**不静默降级**。对 `bind --replay` 而言，能力不足则**连绑定都不执行**。
- **回放后 runtime**：load 出来的 agent 进程本就带全上下文，回放结束后**直接留作该 topic 的活 runtime**（省一次重启），后续消息正常继续。实现时确认 supersede 时序不会打断回放。

## 组件设计

### 1. 回放内核（共用）

一个模块，输入 `(chatId, threadId, sessionId, agent 调用参数)`，流程：

1. **能力校验**：spawn+init 后确认 `agentCapabilities.loadSession` 为真，否则抛 `AgentReplayUnsupportedError`。
2. **强制 load**：调用 `connection.loadSession({ sessionId, cwd, mcpServers: [] })`，**绕过 resume 优先级**。需要一个新的 spawn 变体（如 `spawnAndLoadAgent`）或给现有 bootstrap 传 `forceLoad` 意图。
3. **捕获历史**：在 load 期间收集流回的 `session/update`。收集器是一个**纯函数 reducer**：`sessionUpdate[] → HistoryTurn[]`，其中 `HistoryTurn = { userText: string; agentText: string }`。只保留 `user` 输入与 `agent_message_chunk`（拼成最终文本），跳过 thought / tool。
4. **渲染**：每个 `HistoryTurn` 独立喂进现有对话渲染管线，作为一个 Response（用户输入 + agent 文本），走 `ResponseCardProjector` + 卡片预算，`replyCard` + `replyInThread`（`CardRoute.th`）落进当前 thread。
5. **边界 notice**：首张回放卡前发一条 notice：“以下为历史回放（N 轮）”，让边界清楚。

### 2. `/replay` slash command（`src/interpreter/commands.ts` + `src/gateway/gateway.ts`）

- `commands.ts`：新增 `LarkCommand` 变体 `{ kind: "replay" }`、`SlashCommandContext.replay()`；用 `defineExactCommand` 精确匹配 `/replay`，group `"Repo / session"`，进 `/help`。加入 `SLASH_COMMANDS`。
- `gateway.ts`：`createSlashCommandContext`（gateway.ts:1804）里接 `replay: () => this.handleReplayCommand(chatId, threadId, messageId)`。
- `handleReplayCommand`：
  - 取当前 topic 已绑 session（`sessionStore.getLatest`）；无 → notice“当前 topic 未绑定 session，无法回放”。
  - 能力校验失败 → notice fail-fast。
  - 否则调用回放内核。
- **重复回放**：允许多次触发，每次把历史重新刷一遍卡片。不做去重——手动触发即用户明确想再看一遍。

### 3. `session bind --replay`（`bin/cli/commands/session.ts` + gateway control）

- CLI `bind` 新增布尔 flag `--replay`（默认 false），透传给 gateway control：`bindSession` 参数扩展为 `{ record, replay }`（或新增 control method）。
- 流程：先切绑定指针，再调用回放内核。能力不足则连绑定都不执行（fail-fast）。
- **gateway 未运行的 fallback**（直接写 `FileSessionStore`）**不支持** replay——回放必须由活着的 agent 进程流式产生。带 `--replay` 且 gateway 未运行 → 报错“历史回放需要 gateway 运行”。

### 4. 文档更新（`~/.humming/AGENTS.md` 与仓库 `CLAUDE.md` 的 Humming 指引）

在 session 操作段落补充：

- `/replay`（Feishu 内手动回放当前已绑 session 的历史）。
- `session bind --session-id <id> --replay`（绑定并回放）。
- 自然语言映射规则：用户说“绑定 Session 并且重放历史” → 执行 `session bind --session-id <id> --replay`。

## 错误类型

- `AgentReplayUnsupportedError`：agent 不支持 `loadSession`。携带 `sessionId` 上下文。
- gateway 未运行 + `--replay`：CLI 层报错，说明需要 gateway 运行。

## 测试

- **单元**：
  - sessionUpdate reducer：各种 chunk 序列（纯文本、含 thought、含 tool、交错、空历史）→ `HistoryTurn[]`。
  - CLI `--replay` flag 解析。
  - `/replay` slash command 解析（精确匹配、`/help` 收录、token 唯一性）。
  - 能力校验报错路径。
- **白箱**：强制 load 的 spawn 变体（`<module>.test.ts`，与被测同目录）。
- **手动 E2E**：
  - 绑一个有历史的 session 带 `--replay`：历史逐 turn 成卡、长 turn 自动分卡、回放后能继续对话。
  - `/replay` 对已绑 session 手动触发；未绑 topic 触发得到 notice。
  - agent 仅支持 resume：`bind --replay` fail-fast 且未绑定；`/replay` fail-fast notice。

## 非目标（YAGNI）

- 不在本地持久化 transcript。
- 不回放 thought / tool 细节。
- 不做回放去重 / 增量回放。
- 不支持 gateway 未运行时的回放。
