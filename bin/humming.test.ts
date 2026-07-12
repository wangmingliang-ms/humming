/**
 * CLI-layer unit tests for the default-agent resolution that makes a bare
 * `humming start` / `humming proxy` work on a fresh machine.
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
  migrateLegacyIfNeeded,
  resolveHomeDir,
  parseControlJson,
  readControlPatchInput,
  readControlJsonInput,
  resolveSessionTargetContext,
  runInit,
  resolveUpdateRef,
  restartHasExplicitOptions,
  resolveConversationCardFeature,
  runCardsV2,
  validateRollbackCheckout,
  writeConversationCardFeature,
  DEFAULT_AGENT,
  DEFAULT_PERMISSION_MODE,
  type ParsedArgs,
} from "./humming.js";
import { buildRegistry } from "./agents.js";

const registry = buildRegistry();

const silentLogger = {
  debug(): void {},
  info(): void {},
  warn(): void {},
  error(): void {},
  child(): typeof silentLogger {
    return silentLogger;
  },
};

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

  it("accepts explicit init without spawning the bridge", () => {
    const args = parseArgs(["--home", "/tmp/humming-home", "init"]);
    expect(args.command).toBe("init");
    expect(args.home).toBe("/tmp/humming-home");
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

describe("parseArgs — update subcommand", () => {
  it("accepts a bare `update`", () => {
    const args = parseArgs(["update"]);
    expect(args.command).toBe("update");
    expect(args.agentPreset).toBeUndefined();
    // update does not background a proxy, so it captures no argv/index.
    expect(args.rawArgv).toBeUndefined();
    expect(args.subcommandIndex).toBeUndefined();
  });

  it("honors a --home global option before update", () => {
    const args = parseArgs(["--home", "/tmp/humming-home", "update"]);
    expect(args.command).toBe("update");
    expect(args.home).toBe("/tmp/humming-home");
  });

  it("ignores trailing tokens after update, like other terminal subcommands", () => {
    // `update` returns as soon as its token is matched (same as status/stop/
    // init/agents), so trailing tokens are dropped rather than rejected. update
    // takes no options of its own — its only knob is the $HUMMING_REF env var.
    const args = parseArgs(["update", "extra", "tokens"]);
    expect(args.command).toBe("update");
  });
});

describe("conversation card lifecycle feature settings", () => {
  it("defaults the persisted gate off when features are absent", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "humming-feature-config-"));
    try {
      const settingsPath = path.join(dir, "settings.json");
      fs.writeFileSync(settingsPath, JSON.stringify({ credentials: {}, runtime: {} }));

      const config = readConfigFile(settingsPath);

      expect(config.features.conversationCardLifecycleV2).toBe(false);
      expect(resolveConversationCardFeature(config.features, 2)).toEqual({ v2Enabled: false });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a persisted true gate when the binary schema is too old", () => {
    expect(() =>
      resolveConversationCardFeature({ conversationCardLifecycleV2: true }, 1),
    ).toThrowError(/requires card action schema version 2/);
  });

  it("enables only after live schema verification, persistence, reread, then restart", async () => {
    const calls: string[] = [];
    let persisted = false;
    await runCardsV2(
      { command: "cards-v2", cardsV2Action: "enable", agentExtraArgs: [] },
      {
        queryStatus: async () => {
          calls.push("status");
          return { cardActionSchemaVersion: 2, conversationCardLifecycleV2Enabled: false };
        },
        persist: (enabled) => {
          calls.push(`persist:${enabled}`);
          persisted = enabled;
        },
        reread: () => {
          calls.push("reread");
          return persisted;
        },
        restart: async () => {
          calls.push("restart");
        },
        stop: async () => {
          calls.push("stop");
        },
        start: async () => {
          calls.push("start");
        },
        validateCheckout: () => {
          calls.push("validate");
          return "/target/dist/bin/humming.js";
        },
      },
    );
    expect(calls).toEqual(["status", "persist:true", "reread", "restart"]);
  });

  it("refuses enable without schema 2 before mutating settings", async () => {
    const calls: string[] = [];
    await expect(
      runCardsV2(
        { command: "cards-v2", cardsV2Action: "enable", agentExtraArgs: [] },
        {
          queryStatus: async () => ({
            cardActionSchemaVersion: 1,
            conversationCardLifecycleV2Enabled: false,
          }),
          persist: () => calls.push("persist"),
          reread: () => false,
          restart: async () => calls.push("restart"),
          stop: async () => calls.push("stop"),
          start: async () => calls.push("start"),
          validateCheckout: () => "/target/dist/bin/humming.js",
        },
      ),
    ).rejects.toThrow(/schema version 2/);
    expect(calls).toEqual([]);
  });

  it("online disable persists false, rereads, then restarts without status/stop/start", async () => {
    const calls: string[] = [];
    let persisted = true;
    await runCardsV2(
      { command: "cards-v2", cardsV2Action: "disable", agentExtraArgs: [] },
      {
        queryStatus: async () => {
          calls.push("status");
          return { cardActionSchemaVersion: 2, conversationCardLifecycleV2Enabled: true };
        },
        persist: (enabled) => {
          calls.push(`persist:${enabled}`);
          persisted = enabled;
        },
        reread: () => {
          calls.push("reread");
          return persisted;
        },
        restart: async () => {
          calls.push("restart");
        },
        stop: async () => {
          calls.push("stop");
        },
        start: async () => {
          calls.push("start");
        },
        validateCheckout: () => "/target/dist/bin/humming.js",
      },
    );
    expect(calls).toEqual(["persist:false", "reread", "restart"]);
  });

  it("offline disable persists and rereads without touching control or process APIs", async () => {
    const calls: string[] = [];
    let persisted = true;
    await runCardsV2(
      {
        command: "cards-v2",
        cardsV2Action: "disable",
        cardsV2Offline: true,
        agentExtraArgs: [],
      },
      {
        queryStatus: async () => {
          calls.push("status");
          return { cardActionSchemaVersion: 2, conversationCardLifecycleV2Enabled: true };
        },
        persist: (enabled) => {
          calls.push(`persist:${enabled}`);
          persisted = enabled;
        },
        reread: () => {
          calls.push("reread");
          return persisted;
        },
        restart: async () => {
          calls.push("restart");
        },
        stop: async () => {
          calls.push("stop");
        },
        start: async () => {
          calls.push("start");
        },
        validateCheckout: () => {
          calls.push("validate");
          return "/target/dist/bin/humming.js";
        },
      },
    );
    expect(calls).toEqual(["persist:false", "reread"]);
  });

  it("parses the exact management commands and rejects relative rollback checkouts", () => {
    expect(parseArgs(["cards-v2", "enable"])).toMatchObject({
      command: "cards-v2",
      cardsV2Action: "enable",
    });
    expect(parseArgs(["cards-v2", "disable", "--offline"])).toMatchObject({
      command: "cards-v2",
      cardsV2Action: "disable",
      cardsV2Offline: true,
    });
    expect(parseArgs(["cards-v2", "rollback", "--checkout", "/old/humming"])).toMatchObject({
      command: "cards-v2",
      cardsV2Action: "rollback",
      cardsV2Checkout: "/old/humming",
    });
    expect(() => parseArgs(["cards-v2", "rollback", "--checkout", "relative/humming"])).toThrow(
      /absolute path/,
    );
  });

  it("persists only the gate while preserving unrelated settings", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "humming-feature-write-"));
    try {
      const settingsPath = path.join(dir, "settings.json");
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({
          credentials: { appId: "keep" },
          features: { other: "keep", conversationCardLifecycleV2: true },
          runtime: { agent: "codex" },
        }),
      );
      writeConversationCardFeature(settingsPath, false);
      expect(JSON.parse(fs.readFileSync(settingsPath, "utf-8"))).toEqual({
        credentials: { appId: "keep" },
        features: { other: "keep", conversationCardLifecycleV2: false },
        runtime: { agent: "codex" },
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("validates rollback guard marker, guard test, and built CLI", () => {
    const checkout = fs.mkdtempSync(path.join(os.tmpdir(), "humming-rollback-target-"));
    try {
      fs.mkdirSync(path.join(checkout, "src", "bridge"), { recursive: true });
      fs.mkdirSync(path.join(checkout, "dist", "bin"), { recursive: true });
      fs.writeFileSync(
        path.join(checkout, "src", "bridge", "bridge.ts"),
        'if (Object.hasOwn(value, "v")) return;',
      );
      fs.writeFileSync(
        path.join(checkout, "src", "bridge", "bridge-card-lifecycle.test.ts"),
        "test",
      );
      fs.writeFileSync(path.join(checkout, "dist", "bin", "humming.js"), "#!/usr/bin/env node");
      expect(validateRollbackCheckout(checkout)).toBe(
        path.join(checkout, "dist", "bin", "humming.js"),
      );
      fs.rmSync(path.join(checkout, "src", "bridge", "bridge-card-lifecycle.test.ts"));
      expect(() => validateRollbackCheckout(checkout)).toThrow(/guard test/);
    } finally {
      fs.rmSync(checkout, { recursive: true, force: true });
    }
  });

  it("rolls back in validate, persist false, reread, stop, explicit target start order", async () => {
    const calls: string[] = [];
    let persisted = true;
    await runCardsV2(
      {
        command: "cards-v2",
        cardsV2Action: "rollback",
        cardsV2Checkout: "/target",
        agentExtraArgs: [],
      },
      {
        queryStatus: async () => ({
          cardActionSchemaVersion: 2,
          conversationCardLifecycleV2Enabled: true,
        }),
        persist: (enabled) => {
          calls.push(`persist:${enabled}`);
          persisted = enabled;
        },
        reread: () => {
          calls.push("reread");
          return persisted;
        },
        restart: async () => {},
        stop: async () => {
          calls.push("stop");
        },
        start: async (selfPath) => {
          calls.push(`start:${selfPath}`);
        },
        validateCheckout: (checkout) => {
          calls.push(`validate:${checkout}`);
          return "/target/dist/bin/humming.js";
        },
      },
    );
    expect(calls).toEqual([
      "validate:/target",
      "persist:false",
      "reread",
      "stop",
      "start:/target/dist/bin/humming.js",
    ]);
  });

  it("does not stop rollback when persistence or reread fails", async () => {
    const makeOps = (persist: () => void, reread: () => boolean) => {
      const calls: string[] = [];
      return {
        calls,
        ops: {
          queryStatus: async () => ({
            cardActionSchemaVersion: 2,
            conversationCardLifecycleV2Enabled: true,
          }),
          persist,
          reread,
          restart: async () => {},
          stop: async () => {
            calls.push("stop");
          },
          start: async () => {
            calls.push("start");
          },
          validateCheckout: () => "/target/dist/bin/humming.js",
        },
      };
    };
    const args: ParsedArgs = {
      command: "cards-v2",
      cardsV2Action: "rollback",
      cardsV2Checkout: "/target",
      agentExtraArgs: [],
    };
    const persistence = makeOps(
      () => {
        throw new Error("disk full");
      },
      () => false,
    );
    await expect(runCardsV2(args, persistence.ops)).rejects.toThrow("disk full");
    expect(persistence.calls).toEqual([]);

    const reread = makeOps(
      () => {},
      () => true,
    );
    await expect(runCardsV2(args, reread.ops)).rejects.toThrow(/failed to reread/);
    expect(reread.calls).toEqual([]);
  });

  it("leaves the gate disabled and reports target start failure after stop", async () => {
    let persisted = true;
    const calls: string[] = [];
    await expect(
      runCardsV2(
        {
          command: "cards-v2",
          cardsV2Action: "rollback",
          cardsV2Checkout: "/target",
          agentExtraArgs: [],
        },
        {
          queryStatus: async () => ({
            cardActionSchemaVersion: 2,
            conversationCardLifecycleV2Enabled: true,
          }),
          persist: (enabled) => {
            persisted = enabled;
          },
          reread: () => persisted,
          restart: async () => {},
          stop: async () => {
            calls.push("stop");
          },
          start: async () => {
            calls.push("start");
            throw new Error("target failed");
          },
          validateCheckout: () => "/target/dist/bin/humming.js",
        },
      ),
    ).rejects.toThrow("target failed");
    expect(calls).toEqual(["stop", "start"]);
    expect(persisted).toBe(false);
  });
});

describe("resolveUpdateRef — $HUMMING_REF override", () => {
  const original = process.env["HUMMING_REF"];
  afterEach(() => {
    restoreEnv("HUMMING_REF", original);
  });

  it("defaults to main when unset", () => {
    delete process.env["HUMMING_REF"];
    expect(resolveUpdateRef()).toBe("main");
  });

  it("defaults to main when set to an empty string", () => {
    process.env["HUMMING_REF"] = "";
    expect(resolveUpdateRef()).toBe("main");
  });

  it("uses a non-empty $HUMMING_REF verbatim", () => {
    process.env["HUMMING_REF"] = "release-1.2";
    expect(resolveUpdateRef()).toBe("release-1.2");
  });
});

describe("restartHasExplicitOptions — bare restart vs. restart with flags", () => {
  it("is false for a bare restart (falls back to the persisted launch argv)", () => {
    expect(restartHasExplicitOptions(parseArgs(["restart"]))).toBe(false);
  });

  it("is true when the restart carries a proxy option", () => {
    expect(restartHasExplicitOptions(parseArgs(["restart", "--agent", "codex"]))).toBe(true);
  });

  it("is true when a global option precedes restart with trailing proxy flags", () => {
    // `--home <dir> restart --agent codex`: subcommand token is at index 2, and
    // argv extends past it, so the typed options win over the persisted file.
    const args = parseArgs(["--home", "/tmp/h", "restart", "--agent", "codex"]);
    expect(restartHasExplicitOptions(args)).toBe(true);
  });
});

describe("parseArgs — control and session-control subcommands", () => {
  it("parses live capabilities target flags", () => {
    const args = parseArgs([
      "control",
      "capabilities",
      "--chat-id",
      "oc_A",
      "--thread-id",
      "th_1",
      "--json",
    ]);
    expect(args.command).toBe("control");
    expect(args.controlAction).toBe("capabilities");
    expect(args.targetChatId).toBe("oc_A");
    expect(args.targetThreadId).toBe("th_1");
    expect(args.controlJson).toBe(true);
  });

  it("parses agent capabilities probe flags", () => {
    const args = parseArgs([
      "control",
      "agent-capabilities",
      "--chat-id",
      "oc_A",
      "--agent",
      "copilot",
      "--cwd",
      "/repo",
      "--json",
    ]);
    expect(args.command).toBe("control");
    expect(args.controlAction).toBe("agent-capabilities");
    expect(args.targetChatId).toBe("oc_A");
    expect(args.targetAgent).toBe("copilot");
    expect(args.targetCwd).toBe("/repo");
    expect(args.controlJson).toBe(true);
  });

  it("parses set-agent as a topic-level profile change", () => {
    const args = parseArgs([
      "sessions",
      "set-agent",
      "--chat-id",
      "oc_A",
      "--thread-id",
      "th_1",
      "--agent",
      "copilot",
    ]);
    expect(args.command).toBe("sessions");
    expect(args.sessionsAction).toBe("set-agent");
    expect(args.targetChatId).toBe("oc_A");
    expect(args.targetThreadId).toBe("th_1");
    expect(args.targetAgent).toBe("copilot");

    expect(() =>
      parseArgs([
        "sessions",
        "set-agent",
        "--chat-id",
        "oc_A",
        "--agent",
        "copilot",
        "--cwd",
        "/repo",
      ]),
    ).toThrowError(/does not accept --cwd/);

    expect(() =>
      parseArgs([
        "sessions",
        "set-agent",
        "--chat-id",
        "oc_A",
        "--agent",
        "copilot",
        "--json",
        '{"modelId":"opus"}',
      ]),
    ).toThrowError(/does not accept --json/);
  });

  it("parses set-control JSON payloads", () => {
    const json = '{"modeId":"agent"}';
    const args = parseArgs([
      "sessions",
      "set-control",
      "--chat-id",
      "oc_A",
      "--thread-id",
      "<main>",
      "--json",
      json,
    ]);
    expect(args.command).toBe("sessions");
    expect(args.sessionsAction).toBe("set-control");
    expect(args.targetChatId).toBe("oc_A");
    expect(args.targetThreadId).toBeNull();
    expect(args.controlJson).toBe(json);
  });

  it("parses atomic pending target profile inputs", () => {
    const json = '{"modelId":"gpt-5.5"}';
    const args = parseArgs([
      "sessions",
      "set-pending-target-profile",
      "--chat-id",
      "oc_A",
      "--thread-id",
      "th_1",
      "--agent",
      "copilot",
      "--json",
      json,
      "--prompt",
      "do the task",
    ]);
    expect(args.command).toBe("sessions");
    expect(args.sessionsAction).toBe("set-pending-target-profile");
    expect(args.targetChatId).toBe("oc_A");
    expect(args.targetThreadId).toBe("th_1");
    expect(args.targetAgent).toBe("copilot");
    expect(args.controlJson).toBe(json);
    expect(args.promptText).toBe("do the task");
  });

  it("rejects reserved core profile fields inside config JSON", () => {
    expect(() => parseControlJson('{"config":{"model":{"value":"gpt-5.6-sol"}}}')).toThrowError(
      /controls\.config\.model.*modelId.*top-level/,
    );
    expect(() => parseControlJson('{"config":{"Agent":{"value":"copilot"}}}')).toThrowError(
      /controls\.config\.Agent.*agent.*top-level/,
    );
  });

  it("parses split session control flags without requiring JSON", () => {
    const args = parseArgs([
      "sessions",
      "set-control",
      "--chat-id",
      "oc_A",
      "--model",
      "gpt-5.5",
      "--mode",
      "agent",
      "--permission",
      "alwaysAllow",
    ]);
    expect(args.sessionsAction).toBe("set-control");
    expect(args.controlJson).toBeUndefined();
    expect(readControlPatchInput(args, { required: true })).toEqual({
      modelId: "gpt-5.5",
      modeId: "agent",
      bridgePermissionMode: "alwaysAllow",
    });
  });

  it("parses split pending target profile control flags only when an agent is named", () => {
    const args = parseArgs([
      "sessions",
      "set-pending-target-profile",
      "--chat-id",
      "oc_A",
      "--agent",
      "copilot",
      "--model",
      "gpt-5.5",
      "--prompt",
      "do the task",
    ]);
    expect(args.sessionsAction).toBe("set-pending-target-profile");
    expect(args.targetAgent).toBe("copilot");
    expect(readControlPatchInput(args, { required: false })).toEqual({ modelId: "gpt-5.5" });

    expect(() =>
      parseArgs([
        "sessions",
        "set-pending-target-profile",
        "--chat-id",
        "oc_A",
        "--model",
        "gpt-5.5",
        "--prompt",
        "do the task",
      ]),
    ).toThrowError(/requires --agent/);
  });

  it("parses set-control JSON file and stdin payload sources", () => {
    const fromFile = parseArgs([
      "sessions",
      "set-control",
      "--chat-id",
      "oc_A",
      "--json-file",
      "controls.json",
    ]);
    expect(fromFile.sessionsAction).toBe("set-control");
    expect(fromFile.controlJsonFile).toBe("controls.json");
    expect(fromFile.controlJson).toBeUndefined();

    const fromStdin = parseArgs(["sessions", "set-control", "--chat-id", "oc_A", "--json-stdin"]);
    expect(fromStdin.sessionsAction).toBe("set-control");
    expect(fromStdin.controlJsonStdin).toBe(true);
    expect(fromStdin.controlJson).toBeUndefined();
  });

  it("parses queue-task prompt payload sources", () => {
    const inline = parseArgs([
      "sessions",
      "queue-task",
      "--chat-id",
      "oc_A",
      "--thread-id",
      "th_1",
      "--prompt",
      "implement X",
    ]);
    expect(inline.command).toBe("sessions");
    expect(inline.sessionsAction).toBe("queue-task");
    expect(inline.targetChatId).toBe("oc_A");
    expect(inline.targetThreadId).toBe("th_1");
    expect(inline.promptText).toBe("implement X");

    const trailing = parseArgs([
      "sessions",
      "queue-task",
      "--chat-id",
      "oc_A",
      "--",
      "implement",
      "Y",
    ]);
    expect(trailing.sessionsAction).toBe("queue-task");
    expect(trailing.promptText).toBe("implement Y");

    const fromFile = parseArgs([
      "sessions",
      "queue-task",
      "--chat-id",
      "oc_A",
      "--prompt-file",
      "task.md",
    ]);
    expect(fromFile.promptFile).toBe("task.md");

    const fromStdin = parseArgs(["sessions", "queue-task", "--chat-id", "oc_A", "--prompt-stdin"]);
    expect(fromStdin.promptStdin).toBe(true);
  });

  it("rejects ambiguous or missing queue-task prompt payload sources", () => {
    expect(() => parseArgs(["sessions", "queue-task", "--chat-id", "oc_A"])).toThrowError(
      /exactly one of --prompt/,
    );
    expect(() =>
      parseArgs([
        "sessions",
        "queue-task",
        "--chat-id",
        "oc_A",
        "--prompt",
        "x",
        "--prompt-file",
        "task.md",
      ]),
    ).toThrowError(/exactly one of --prompt/);
  });

  it("rejects ambiguous or missing set-control payload sources", () => {
    expect(() => parseArgs(["sessions", "set-control", "--chat-id", "oc_A"])).toThrowError(
      /exactly one controls source/,
    );
    expect(() =>
      parseArgs([
        "sessions",
        "set-control",
        "--chat-id",
        "oc_A",
        "--json",
        '{"modeId":"agent"}',
        "--json-file",
        "controls.json",
      ]),
    ).toThrowError(/exactly one controls source/);
  });

  it("parses session list with optional cwd and agent", () => {
    const args = parseArgs([
      "sessions",
      "list",
      "--chat-id",
      "oc_A",
      "--thread-id",
      "th_1",
      "--agent",
      "claude",
      "--cwd",
      "/repo",
      "--json",
    ]);
    expect(args.command).toBe("sessions");
    expect(args.sessionsAction).toBe("list");
    expect(args.targetChatId).toBe("oc_A");
    expect(args.targetThreadId).toBe("th_1");
    expect(args.targetAgent).toBe("claude");
    expect(args.targetCwd).toBe("/repo");
    expect(args.controlJson).toBe(true);
  });

  it("resolves session-control cwd from latest session or reception cwd", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "humming-session-cwd-"));
    try {
      const home = path.join(dir, "home");
      const repo = path.join(dir, "repo");
      const reception = path.join(dir, "reception");
      fs.mkdirSync(repo, { recursive: true });
      fs.mkdirSync(reception, { recursive: true });
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(
        path.join(home, "settings.json"),
        JSON.stringify({
          runtime: { agent: "claude", unboundCwd: reception },
          credentials: { appId: "cli_x", appSecret: "secret" },
        }),
      );
      fs.writeFileSync(
        path.join(home, "sessions.json"),
        JSON.stringify({
          oc_A: [
            {
              chatId: "oc_A",
              threadId: "th_1",
              sessionId: "sess_1",
              agentCommand: "npx",
              agentArgs: ["-y", "@github/copilot", "--acp"],
              agentLabel: "copilot",
              cwd: repo,
              createdAt: 1,
              updatedAt: 2,
            },
          ],
        }),
      );

      const fromSession = resolveSessionTargetContext(
        parseArgs([
          "--home",
          home,
          "sessions",
          "set-agent",
          "--chat-id",
          "oc_A",
          "--thread-id",
          "th_1",
          "--agent",
          "claude",
        ]),
      );
      expect(fromSession.cwd).toBe(repo);

      const fromReception = resolveSessionTargetContext(
        parseArgs([
          "--home",
          home,
          "sessions",
          "set-agent",
          "--chat-id",
          "oc_B",
          "--agent",
          "claude",
        ]),
      );
      expect(fromReception.cwd).toBe(reception);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to Humming chat/thread env vars for in-agent commands", () => {
    const oldChat = process.env.HUMMING_CHAT_ID;
    const oldThread = process.env.HUMMING_THREAD_ID;
    try {
      process.env.HUMMING_CHAT_ID = "oc_env";
      process.env.HUMMING_THREAD_ID = "omt_env";

      const caps = parseArgs(["control", "capabilities", "--json"]);
      expect(caps.targetChatId).toBe("oc_env");
      expect(caps.targetThreadId).toBe("omt_env");

      const bind = parseArgs(["sessions", "bind", "--agent", "claude", "--session-id", "sess_1"]);
      expect(bind.targetChatId).toBe("oc_env");
      expect(bind.targetThreadId).toBe("omt_env");

      process.env.HUMMING_THREAD_ID = "";
      const main = parseArgs(["sessions", "set-agent", "--agent", "copilot"]);
      expect(main.targetChatId).toBe("oc_env");
      expect(main.targetThreadId).toBeNull();
    } finally {
      if (oldChat === undefined) delete process.env.HUMMING_CHAT_ID;
      else process.env.HUMMING_CHAT_ID = oldChat;
      if (oldThread === undefined) delete process.env.HUMMING_THREAD_ID;
      else process.env.HUMMING_THREAD_ID = oldThread;
    }
  });

  it("parses session bind and rejects cwd", () => {
    const args = parseArgs([
      "sessions",
      "bind",
      "--chat-id",
      "oc_A",
      "--thread-id",
      "th_1",
      "--agent",
      "codex",
      "--session-id",
      "sess_1",
    ]);
    expect(args.sessionsAction).toBe("bind");
    expect(args.targetChatId).toBe("oc_A");
    expect(args.targetThreadId).toBe("th_1");
    expect(args.targetAgent).toBe("codex");
    expect(args.targetSessionId).toBe("sess_1");

    expect(() =>
      parseArgs([
        "sessions",
        "bind",
        "--chat-id",
        "oc_A",
        "--session-id",
        "sess_1",
        "--cwd",
        "/repo",
      ]),
    ).toThrowError(/does not accept --cwd/);
  });
});

describe("parseControlJson", () => {
  it("accepts ACP-shaped controls and normalizes select config values", () => {
    expect(
      parseControlJson(
        JSON.stringify({
          modelId: "model-new",
          modeId: "agent",
          bridgePermissionMode: "alwaysAsk",
          config: {
            auto_edit: { type: "boolean", value: true },
            approval_mode: { type: "select", value: "auto" },
          },
        }),
      ),
    ).toEqual({
      modelId: "model-new",
      modeId: "agent",
      bridgePermissionMode: "alwaysAsk",
      config: {
        auto_edit: { type: "boolean", value: true },
        approval_mode: { value: "auto" },
      },
    });
  });

  it("reads set-control payloads from a JSON file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "humming-json-file-"));
    try {
      const file = path.join(dir, "controls.json");
      fs.writeFileSync(file, '{"modeId":"agent"}', "utf-8");
      const args = parseArgs(["sessions", "set-control", "--chat-id", "oc_A", "--json-file", file]);
      expect(readControlJsonInput(args)).toBe('{"modeId":"agent"}');
      expect(parseControlJson(readControlJsonInput(args))).toEqual({ modeId: "agent" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects invalid permission modes", () => {
    expect(() => parseControlJson('{"bridgePermissionMode":"bypass"}')).toThrowError(
      /bridgePermissionMode/,
    );
  });

  it("rejects core profile fields under config controls", () => {
    expect(() => parseControlJson('{"config":{"model":{"value":"gpt-5.5"}}}')).toThrowError(
      /controls\.config\.model.*modelId/,
    );
  });
});

describe("runInit", () => {
  let dir: string;
  let stdoutSpy: ReturnType<typeof viSpyWrite>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "humming-init-"));
    stdoutSpy = viSpyWrite();
  });

  afterEach(() => {
    stdoutSpy.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("seeds templates/examples but does not create live settings or sessions", async () => {
    const home = path.join(dir, "home");
    await runInit(parseArgs(["--home", home, "init"]));

    expect(fs.existsSync(path.join(home, "AGENTS.md"))).toBe(true);
    expect(fs.existsSync(path.join(home, "CLAUDE.md"))).toBe(true);
    expect(
      JSON.parse(fs.readFileSync(path.join(home, "settings.back.json"), "utf-8")),
    ).toMatchObject({
      runtime: { agent: "claude" },
    });
    expect(
      JSON.parse(fs.readFileSync(path.join(home, "sessions.back.json"), "utf-8")),
    ).toMatchObject({
      oc_example_chat_id: [{ controls: { bridgePermissionMode: "alwaysAsk" } }],
    });
    expect(fs.existsSync(path.join(home, "settings.json"))).toBe(false);
    expect(fs.existsSync(path.join(home, "sessions.json"))).toBe(false);
    expect(stdoutSpy.output()).toContain("initialized humming home templates");
  });
});

function viSpyWrite(): { output(): string; restore(): void } {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  return {
    output: () => chunks.join(""),
    restore: () => {
      process.stdout.write = original;
    },
  };
}

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
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "humming-cfg-"));
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

  it("reads lifecycle notification chat ids from settings.json", () => {
    const p = path.join(dir, "settings.json");
    fs.writeFileSync(p, JSON.stringify({ runtime: { lifecycleNotifyChatIds: ["oc_A", "oc_B"] } }));
    const cfg = readConfigFile(p);
    expect(cfg.runtime.lifecycleNotifyChatIds).toEqual(["oc_A", "oc_B"]);
  });

  it("rejects non-string lifecycle notification chat ids", () => {
    const p = path.join(dir, "settings.json");
    fs.writeFileSync(p, JSON.stringify({ runtime: { lifecycleNotifyChatIds: ["oc_A", 42] } }));
    expect(() => readConfigFile(p)).toThrowError(
      /runtime\.lifecycleNotifyChatIds\[1\] must be a string/,
    );
  });
});

describe("legacy migration isolation", () => {
  let dir: string;
  const oldXdgConfig = process.env["XDG_CONFIG_HOME"];
  const oldXdgData = process.env["XDG_DATA_HOME"];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "humming-migrate-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    restoreEnv("XDG_CONFIG_HOME", oldXdgConfig);
    restoreEnv("XDG_DATA_HOME", oldXdgData);
  });

  it("does not import legacy XDG config into an explicit --home", () => {
    const xdgConfig = path.join(dir, "xdg-config");
    const legacyDir = path.join(xdgConfig, "humming");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(
      path.join(legacyDir, "config.json"),
      JSON.stringify({ credentials: { appId: "cli_legacy", appSecret: "secret" } }),
    );
    process.env["XDG_CONFIG_HOME"] = xdgConfig;
    process.env["XDG_DATA_HOME"] = path.join(dir, "xdg-data");

    const explicitHome = path.join(dir, "explicit-home");
    const settings = path.join(explicitHome, "settings.json");
    migrateLegacyIfNeeded(explicitHome, settings, silentLogger);

    expect(fs.existsSync(settings)).toBe(false);
  });
});

describe("default permission mode", () => {
  it("defaults runtime.permissionMode to ask when unset", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "humming-permission-default-"));
    try {
      const settings = path.join(dir, "settings.json");
      fs.writeFileSync(
        settings,
        JSON.stringify({ credentials: { appId: "cli_x", appSecret: "secret" } }),
      );
      const cfg = readConfigFile(settings);
      const inv = resolveDefaultAgent(parseArgs(["proxy"]), registry, cfg.runtime.agent);
      expect(inv.label).toBe(DEFAULT_AGENT);
      expect(DEFAULT_PERMISSION_MODE).toBe("alwaysAsk");
      expect(cfg.runtime.permissionMode).toBeUndefined();
      expect(parseArgs(["proxy"]).permissionMode).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
