import { expect, it } from "vitest";
import type * as acp from "@agentclientprotocol/sdk/unstable";
import { spawnAgent, killAgent } from "../src/acp/agent-process.js";
import type { LarkLogger } from "../src/logger/logger.js";

const logger: LarkLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return logger;
  },
};

it("registers SDK app handlers before connecting and preserves messages, tools and user confirmation over stdio", async () => {
  const updates: acp.SessionUpdate[] = [];
  const questions: acp.RequestPermissionRequest[] = [];
  const agent = await spawnAgent({
    command: "node",
    args: ["dist/bin/mock-agent.js"],
    cwd: process.cwd(),
    logger,
    client: {
      async sessionUpdate(params) {
        updates.push(params.update);
      },
      async requestPermission(params) {
        questions.push(params);
        const allow = params.options.find((option) => option.kind === "allow_once");
        if (allow === undefined) throw new Error("Mock Agent did not offer confirmation");
        return { outcome: { outcome: "selected", optionId: allow.optionId } };
      },
    },
  });
  try {
    const result = await agent.connection.prompt({
      sessionId: agent.sessionId,
      prompt: [{ type: "text", text: "Exercise the scripted turn" }],
    });
    expect(result.stopReason).toBe("end_turn");
    expect(questions).toHaveLength(1);
    expect(updates.some((update) => update.sessionUpdate === "agent_message_chunk")).toBe(true);
    expect(updates.some((update) => update.sessionUpdate === "tool_call")).toBe(true);
    expect(
      updates.some(
        (update) => update.sessionUpdate === "tool_call_update" && update.status === "completed",
      ),
    ).toBe(true);
  } finally {
    killAgent(agent.process);
  }
});
