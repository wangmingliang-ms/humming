# Rename Bridge → Gateway (全量术语替换)

## 目标

把整个仓库中的 "Bridge" 术语全部替换为 "Gateway"，**零兼容处理**（不保留旧命令别名、旧配置字段、旧状态文件名，不写迁移逻辑）。

## 替换规则（保持大小写 / 语义）

| 原 | 新 |
|---|---|
| `bridge` | `gateway` |
| `Bridge` | `Gateway` |
| `BRIDGE` | `GATEWAY` |
| 中文 `桥接层` | `网关层` |
| 中文 `桥接` | `网关` |

复合标识符随之变化，例如：
- `makeBridge` → `makeGateway`
- `LarkBridge` / `LarkBridgeOptions` → `LarkGateway` / `LarkGatewayOptions`
- `bridgePermissionMode` → `gatewayPermissionMode`（配置字段直接改名，不留旧名 fallback）
- `isBridgeRunning`、`startBridge`、`stopBridge`、`statusBridge` → `is/start/stop/statusGateway`
- `bridgePidPath` / `bridgeLogPath` / `bridgeLaunchPath` / `bridgeUnitName` 等全部跟随

## 波及范围

- **状态产物**：`bridge.pid` → `gateway.pid`，`bridge.log` → `gateway.log`。
- **目录 / 文件重命名**（用 `git mv` 保留历史）：
  - `src/bridge/` → `src/gateway/`（含 `bridge.ts` → `gateway.ts`、`chat-runtime.ts` 内引用）
  - `bin/cli/commands/bridge.ts` → `bin/cli/commands/gateway.ts`
  - `bin/humming-bridge.test.ts` → `bin/humming-gateway.test.ts`
  - 修所有 import 路径。
- **CLI 命令树**：`humming bridge ...` → `humming gateway ...`；顶层快捷方式（`run|start|stop|restart|status|logs`）帮助文本、`--help` 文案同步。
- **文档**：`CLAUDE.md`、`README.md`、`PLAN.md`、`docs/**`、`templates/home/*.md` 里的命令示例与说明（含中文"桥接层"→"网关层"）。

## 不动的范围

- `.git/`、`node_modules/`、`dist/`。
- 无非本概念词（已确认无 `Cambridge`/`abridge` 等）。

## 执行方式

纯机械替换，不写新失败测试；用**现有测试套件作为回归网**：
1. `git mv` 目录 / 文件。
2. 全仓库文本替换（区分大小写 4 条规则 + 中文 2 条）。
3. `tsc --noEmit` → `eslint` → `prettier --check` → `npm test` 全绿。

## 验收

1. `grep -rin bridge`（排除 node_modules/dist/.git）= **0**；中文 `桥` = 0。
2. `tsc --noEmit` 通过。
3. `eslint` + `prettier --check` 通过。
4. `npm test` 全绿。
5. 手动 E2E：`humming gateway start → status → restart → stop`，`gateway.log` 出现 `WebSocket connected`。
