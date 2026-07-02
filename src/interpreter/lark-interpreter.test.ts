import { describe, it, expect } from "vitest";
import type * as Lark from "@larksuiteoapi/node-sdk";
import { interpretLarkMessage, type LarkCommand } from "./lark-interpreter.js";

/**
 * Build a minimal text-message event. The interpreter only reads
 * `message.message_type`, `message.content` (a JSON string) and
 * `message.mentions`, so the rest is filled with inert placeholders.
 */
function textEvent(
  text: string,
  mentions?: Lark.RawMessageEvent["message"]["mentions"],
): Lark.RawMessageEvent {
  const message = {
    message_id: "om_test",
    chat_id: "oc_test",
    chat_type: "p2p",
    message_type: "text",
    content: JSON.stringify({ text }),
    ...(mentions ? { mentions } : {}),
  };
  // The bridge passes the full event; only `message` matters for text parsing.
  return { message } as unknown as Lark.RawMessageEvent;
}

function expectCommand(text: string): LarkCommand {
  const result = interpretLarkMessage(textEvent(text));
  if (result.kind !== "command") {
    throw new Error(`expected command for "${text}", got kind="${result.kind}"`);
  }
  return result.command;
}

describe("interpretLarkMessage — bind commands", () => {
  it("parses `/bind <path> <agent>`", () => {
    expect(expectCommand("/bind ~/workspace/proj claude")).toEqual({
      kind: "bind",
      cwd: "~/workspace/proj",
      agent: "claude",
    });
  });

  it("parses `/bind <path>` with no agent as agent:null", () => {
    expect(expectCommand("/bind /abs/path")).toEqual({
      kind: "bind",
      cwd: "/abs/path",
      agent: null,
    });
  });

  it("keeps a multi-token raw agent command intact", () => {
    expect(expectCommand("/bind ~/proj node ./my-acp.js --port 9000")).toEqual({
      kind: "bind",
      cwd: "~/proj",
      agent: "node ./my-acp.js --port 9000",
    });
  });

  it("treats bare `/bind` as a usage request", () => {
    expect(expectCommand("/bind")).toEqual({ kind: "bind-usage" });
  });

  it("treats `/bind` with only whitespace as a usage request", () => {
    expect(expectCommand("/bind   ")).toEqual({ kind: "bind-usage" });
  });

  it("collapses extra spaces between path and agent", () => {
    expect(expectCommand("/bind   ~/proj    codex")).toEqual({
      kind: "bind",
      cwd: "~/proj",
      agent: "codex",
    });
  });

  it("does NOT match a prefixed lookalike like /bindfoo", () => {
    const result = interpretLarkMessage(textEvent("/bindfoo bar"));
    expect(result.kind).toBe("prompt");
  });
});

describe("interpretLarkMessage — unbind / where", () => {
  it.each(["/unbind", "/unpin"])("parses %s as unbind", (token) => {
    expect(expectCommand(token)).toEqual({ kind: "unbind" });
  });

  it.each(["/where", "/pwd", "/binding"])("parses %s as where", (token) => {
    expect(expectCommand(token)).toEqual({ kind: "where" });
  });

  it("does not treat `/where extra` as a command (exact match only)", () => {
    const result = interpretLarkMessage(textEvent("/where extra"));
    expect(result.kind).toBe("prompt");
  });
});

describe("interpretLarkMessage — existing commands still work", () => {
  it.each(["/cancel", "/stop", "取消", "停止"])("parses %s as cancel", (token) => {
    expect(expectCommand(token)).toEqual({ kind: "cancel" });
  });

  it.each(["/new", "/restart"])("parses %s as new", (token) => {
    expect(expectCommand(token)).toEqual({ kind: "new" });
  });

  it("treats ordinary text as a prompt", () => {
    const result = interpretLarkMessage(textEvent("please fix the bug"));
    expect(result.kind).toBe("prompt");
  });
});
