import fs from "node:fs";
import type * as acp from "@agentclientprotocol/sdk";

/** Strategy for handling agent-side permission requests. */
export type PermissionMode = "alwaysAllow" | "alwaysDeny" | "alwaysAsk";

export const PERMISSION_MODES: readonly PermissionMode[] = [
  "alwaysAsk",
  "alwaysAllow",
  "alwaysDeny",
] as const;

export interface HummingClientOptions {
  permissionMode: PermissionMode;
}

/**
 * Runtime-local ACP infrastructure that is not part of Card presentation.
 * Prompt updates and permissions are routed through PromptCallbackRouter into
 * TopicConversationSession, the sole Conversation/Permission Card lifecycle.
 */
export class HummingClient {
  private permissionMode: PermissionMode;

  constructor(opts: HummingClientOptions) {
    this.permissionMode = opts.permissionMode;
  }

  setPermissionMode(mode: PermissionMode): void {
    this.permissionMode = mode;
  }

  getPermissionMode(): PermissionMode {
    return this.permissionMode;
  }

  async readTextFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
    const content = await fs.promises.readFile(params.path, "utf-8");
    return { content };
  }

  async writeTextFile(params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
    await fs.promises.writeFile(params.path, params.content, "utf-8");
    return {};
  }
}
