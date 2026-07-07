/**
 * Central registry for Humming bridge-side chat commands.
 *
 * Keep command tokens, aliases, permission literals, and `/help` rendering in
 * this file so the parser and user-facing help cannot drift apart.
 */

export type ProfileCommandName = "agent" | "model" | "mode" | "permission";
export type ProfilePermissionMode = "alwaysAsk" | "alwaysAllow" | "alwaysDeny";

export const CANCEL_COMMAND_TOKENS = ["/cancel", "/stop", "取消", "停止"] as const;
export const NEW_SESSION_COMMAND_TOKENS = ["/new", "/restart"] as const;
export const HELP_COMMAND_TOKENS = ["/help", "/commands"] as const;
export const UNBIND_COMMAND_TOKENS = ["/unbind", "/unpin"] as const;
export const WHERE_COMMAND_TOKENS = ["/where", "/pwd", "/binding"] as const;
export const PROFILE_PERMISSION_MODES = ["alwaysAsk", "alwaysAllow", "alwaysDeny"] as const;

export const BIND_COMMAND_TOKEN = "/bind";
export const CAPABILITIES_COMMAND_TOKEN = "/capabilities";
export const AGENT_COMMAND_TOKEN = "/agent";
export const MODEL_COMMAND_TOKEN = "/model";
export const MODE_COMMAND_TOKEN = "/mode";
export const PERMISSION_COMMAND_TOKEN = "/permission";
export const PROFILE_COMMAND_TOKEN = "/profile";

interface CommandHelpEntry {
  readonly syntax: string;
  readonly aliases?: readonly string[];
  readonly description: string;
}

interface CommandHelpGroup {
  readonly title: string;
  readonly entries: readonly CommandHelpEntry[];
}

export const HUMMING_COMMAND_HELP_GROUPS: readonly CommandHelpGroup[] = [
  {
    title: "Discovery",
    entries: [
      {
        syntax: "/help",
        aliases: ["/commands"],
        description: "列出所有 Humming slash commands",
      },
      {
        syntax: "/capabilities",
        description: "列出当前有效 Agent 支持的 model / mode / config / permission controls",
      },
      {
        syntax: "/capabilities <agent>",
        description: "probe 指定 Agent 的 capabilities，只查询不切换",
      },
      { syntax: "/agent", description: "列出可用 Agent" },
      {
        syntax: "/agent <agent>",
        description: "切换当前 topic 的 Agent；会先 probe，失败不改状态",
      },
      { syntax: "/model", description: "通过 ACP capabilities 列出当前 Agent 可用 Models" },
      { syntax: "/model <model-id>", description: "设置当前 topic 的 Model" },
      {
        syntax: "/model auto",
        description: "清除显式 model override，使用 Agent 默认/自动模型",
      },
      { syntax: "/mode", description: "通过 ACP capabilities 列出当前 Agent 可用 Modes" },
      { syntax: "/mode <mode-id>", description: "设置当前 topic 的 Mode" },
      { syntax: "/permission", description: "列出 Humming approval 策略" },
      {
        syntax: "/permission <alwaysAsk|alwaysAllow|alwaysDeny>",
        description: "设置 Humming approval 策略",
      },
      { syntax: "/profile", description: "查看当前 topic profile" },
    ],
  },
  {
    title: "Repo / session",
    entries: [
      { syntax: "/bind <路径>", description: "绑定当前 chat 到 repo" },
      { syntax: "/where", aliases: ["/pwd", "/binding"], description: "查看当前 repo binding" },
      { syntax: "/unbind", aliases: ["/unpin"], description: "解除 repo binding" },
      { syntax: "/new", aliases: ["/restart"], description: "重置当前 topic session" },
      {
        syntax: "/cancel",
        aliases: ["/stop", "取消", "停止"],
        description: "中断当前任务",
      },
    ],
  },
];

export function renderCommandHelpBody(): string {
  return [
    ...HUMMING_COMMAND_HELP_GROUPS.flatMap((group) => [
      `**${group.title}**`,
      ...group.entries.map(renderCommandHelpEntry),
      "",
    ]),
    "裸 /agent /model /mode /permission 只查询可选项，不会修改状态。",
  ].join("\n");
}

function renderCommandHelpEntry(entry: CommandHelpEntry): string {
  const aliases = entry.aliases?.length ? `（别名：${entry.aliases.join("、")}）` : "";
  return `• ${entry.syntax}${aliases} — ${entry.description}`;
}
