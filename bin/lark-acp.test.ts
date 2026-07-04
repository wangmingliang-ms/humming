/**
 * CLI-layer unit tests for the default-agent resolution that makes a bare
 * `lark-acp start` / `lark-acp proxy` work on a fresh machine.
 *
 * Regression guard for the bug where `start` (no `--agent`) spawned a
 * background `proxy` that immediately died with "proxy requires either
 * --agent <preset> or a command after `--`", because:
 *   1. the parser hard-threw on a bare `proxy` (no agent), and
 *   2. there was nowhere to persist a default agent.
 *
 * Both are covered here: the parser now accepts a bare `proxy`, and
 * resolveDefaultAgent walks --agent > settings.json runtime.agent > built-in
 * `claude`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseArgs,
  resolveDefaultAgent,
  readConfigFile,
  DEFAULT_AGENT,
  type ParsedArgs,
} from "./lark-acp.js";
import { buildRegistry } from "./agents.js";

const registry = buildRegistry();

describe("parseArgs — bare subcommands need no --agent", () => {
  it("accepts a bare `proxy` (agent resolved later, not at parse time)", () => {
    const args = parseArgs(["proxy"]);
    expect(args.command).toBe("proxy");
    expect(args.agentPreset).toBeUndefined();
    expect(args.agentRawCommand).toBeUndefined();
  });

  it("accepts a bare `start` and records argv for backgrounding", () => {
    const args = parseArgs(["start"]);
    expect(args.command).toBe("start");
    expect(args.agentPreset).toBeUndefined();
    // start captures the raw argv + the index of its own subcommand token so
    // the handler can rewrite `start` -> `proxy` verbatim.
    expect(args.rawArgv).toEqual(["start"]);
    expect(args.subcommandIndex).toBe(0);
  });

  it("still parses an explicit --agent preset", () => {
    const args = parseArgs(["proxy", "--agent", "codex"]);
    expect(args.agentPreset).toBe("codex");
  });

  it("still parses a raw `-- <cmd>` passthrough", () => {
    const args = parseArgs(["proxy", "--", "node", "./my-acp.js", "--flag"]);
    expect(args.agentRawCommand).toBe("node");
    expect(args.agentExtraArgs).toEqual(["./my-acp.js", "--flag"]);
  });
});

/** Build a ParsedArgs the way parseArgs would, for the CLI-precedence cases. */
function argsFor(argv: readonly string[]): ParsedArgs {
  return parseArgs(argv);
}

describe("resolveDefaultAgent — precedence chain", () => {
  it("falls back to the built-in claude when nothing is specified", () => {
    const inv = resolveDefaultAgent(argsFor(["proxy"]), registry, undefined);
    expect(inv.label).toBe(DEFAULT_AGENT);
    expect(inv.command).toBe("npx");
    expect(inv.args).toContain("@zed-industries/claude-code-acp");
  });

  it("uses settings.json runtime.agent (preset id) when the CLI names none", () => {
    const inv = resolveDefaultAgent(argsFor(["proxy"]), registry, "codex");
    expect(inv.label).toBe("codex");
    expect(inv.args).toContain("@zed-industries/codex-acp");
  });

  it("resolves a runtime.agent raw command string", () => {
    const inv = resolveDefaultAgent(argsFor(["proxy"]), registry, "node ./srv.js --acp");
    expect(inv.command).toBe("node");
    expect(inv.args).toEqual(["./srv.js", "--acp"]);
  });

  it("CLI --agent overrides settings.json runtime.agent", () => {
    const inv = resolveDefaultAgent(argsFor(["proxy", "--agent", "copilot"]), registry, "codex");
    expect(inv.label).toBe("copilot");
  });

  it("CLI raw command overrides settings.json runtime.agent", () => {
    const inv = resolveDefaultAgent(argsFor(["proxy", "--", "node", "x.js"]), registry, "codex");
    expect(inv.command).toBe("node");
    expect(inv.args).toEqual(["x.js"]);
  });

  it("appends --agent extra args to the preset", () => {
    const inv = resolveDefaultAgent(
      argsFor(["proxy", "--agent", "claude", "--", "--verbose"]),
      registry,
      undefined,
    );
    expect(inv.args[inv.args.length - 1]).toBe("--verbose");
  });

  it("throws a friendly error when --agent names an unknown preset", () => {
    expect(() =>
      resolveDefaultAgent(argsFor(["proxy", "--agent", "nope"]), registry, undefined),
    ).toThrowError(/unknown agent preset: nope/);
  });
});

describe("readConfigFile — runtime.agent round-trip", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lark-acp-cfg-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads runtime.agent from settings.json", () => {
    const p = path.join(dir, "settings.json");
    fs.writeFileSync(p, JSON.stringify({ runtime: { agent: "codex" } }));
    const cfg = readConfigFile(p);
    expect(cfg.runtime.agent).toBe("codex");
  });

  it("leaves runtime.agent undefined when absent", () => {
    const p = path.join(dir, "settings.json");
    fs.writeFileSync(p, JSON.stringify({ runtime: {} }));
    const cfg = readConfigFile(p);
    expect(cfg.runtime.agent).toBeUndefined();
  });

  it("rejects a non-string runtime.agent", () => {
    const p = path.join(dir, "settings.json");
    fs.writeFileSync(p, JSON.stringify({ runtime: { agent: 42 } }));
    expect(() => readConfigFile(p)).toThrowError(/runtime\.agent must be a string/);
  });
});
