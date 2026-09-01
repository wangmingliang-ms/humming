import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileConfigSchema } from "../bin/cli/config/schema.js";
import { installHomeTemplates } from "./home-templates.js";

let dir: string;

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("expected a JSON object");
  }
  return value;
}

function expectExactObjectKeys(value: unknown, expectedKeys: readonly string[]): void {
  expect(Object.keys(requireRecord(value)).sort()).toEqual([...expectedKeys].sort());
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "humming-home-templates-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("installHomeTemplates", () => {
  it("installs home guide files and example JSON without creating live settings/sessions", () => {
    const settingsPath = path.join(dir, "settings.json");
    const sessionsPath = path.join(dir, "sessions.json");

    installHomeTemplates({
      homeDir: dir,
      settingsPath,
      sessionsPath,
      controlSocketPath: path.join(dir, "control.sock"),
    });

    const agents = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf-8");
    const claude = fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf-8");
    expect(claude).toBe(agents);
    expect(agents).toContain(settingsPath);
    expect(agents).toContain(sessionsPath);
    expect(agents).toContain(path.join(dir, "control.sock"));
    expect(agents).toContain("## Commands by task");
    expect(agents).toContain("## Decision rules");
    expect(agents).toContain("### Choose the capability source");
    expect(agents).toContain("### Combine profile changes and tasks");
    expect(agents).toContain("### Bind sessions and repositories");
    expect(agents).toContain("### Choose Permission, Mode, or Config");
    expect(agents).toContain("### Handle scope and failures");
    expect(agents).toContain("Bind/rebind repository");
    const guide = agents.replace(/\s+/g, " ");
    expect(guide).toContain("Topic overrides take precedence over the chat default.");
    expect(guide).toContain(
      "In a topic, `/bind <path>` sets that topic override; in the chat main conversation it sets the chat default.",
    );
    expect(guide).toContain("`/bind --chat <path>` explicitly sets the chat default from a topic.");
    expect(guide).toContain(
      "In a topic, `/unbind` removes that topic override so it inherits the chat default; in the chat main conversation it removes the chat default but keeps topic overrides.",
    );
    expect(guide).toContain("`/unbind --chat` removes the chat default from a topic.");
    expect(guide).toContain(
      "`/new` resets only the ACP session; it preserves the repository binding.",
    );
    expect(guide).toContain(
      "`--cwd` is valid only with `session configure --agent`; it updates the current binding scope while switching Agent.",
    );
    expect(guide).toContain(
      "When the user asks in one natural-language request to bind the current topic to an existing Agent session in another repository",
    );
    expect(guide).toContain("humming session configure --agent <agent> --cwd <repo>");
    expect(guide).toContain("humming session bind --agent <agent> --session-id <id>");
    expect(guide).toContain("The configure-then-bind sequence is not atomic.");
    expect(guide).toContain("do not migrate an override from historical `SessionRecord.cwd`.");
    expect(agents).toContain("Agent/Model/Mode/Permission/Config into `bindings`");
    expect(agents).toContain("/agent [agent]");
    expect(agents).toContain("/model [model-id|auto]");
    expect(agents).toContain("/capabilities [agent]");
    expect(agents).toContain("humming session configure --model <model-id|auto>");
    expect(agents).toContain("humming session configure --agent <agent>");
    expect(agents).toContain("Change current Model/Mode/Config");
    expect(agents).toContain("humming session capabilities --json");
    expect(agents).toContain("Switch Agent");
    expect(agents).toContain("humming agent capabilities --agent <target-agent> --json");
    expect(agents).toContain("Query once per unchanged target Agent");
    expect(agents).not.toContain("sessions set-control");
    expect(agents).not.toContain("sessions queue-task");
    expect(agents).not.toContain("set-pending-target-profile");
    expect(agents).not.toContain("humming control ");

    expect(fs.existsSync(settingsPath)).toBe(false);
    expect(fs.existsSync(sessionsPath)).toBe(false);
    const settingsExample: unknown = JSON.parse(
      fs.readFileSync(path.join(dir, "settings.back.json"), "utf-8"),
    );
    const parsedSettingsExample = fileConfigSchema.safeParse(settingsExample);
    expect(parsedSettingsExample.success).toBe(true);
    if (!parsedSettingsExample.success) {
      throw new Error("settings example must satisfy fileConfigSchema");
    }
    expect(parsedSettingsExample.data).toMatchObject({
      credentials: { appId: "cli_xxxxxxxxxxxxxxxx" },
      runtime: { agent: "claude" },
    });

    const bindings = requireRecord(requireRecord(settingsExample)["bindings"]);
    expectExactObjectKeys(bindings, ["oc_example_chat_id"]);
    const exampleBinding = requireRecord(bindings["oc_example_chat_id"]);
    expectExactObjectKeys(exampleBinding, ["cwd", "topics"]);
    expect(exampleBinding["cwd"]).toBe("/absolute/path/to/repo");
    const exampleTopics = requireRecord(exampleBinding["topics"]);
    expectExactObjectKeys(exampleTopics, ["om_example_thread_id"]);
    const exampleTopicBinding = requireRecord(exampleTopics["om_example_thread_id"]);
    expectExactObjectKeys(exampleTopicBinding, ["cwd"]);
    expect(exampleTopicBinding["cwd"]).toBe("/absolute/path/to/topic-repo");
    for (const forbiddenKey of ["agent", "model", "mode", "permission", "config"]) {
      expect(exampleBinding).not.toHaveProperty(forbiddenKey);
      expect(exampleTopicBinding).not.toHaveProperty(forbiddenKey);
    }
    expect(
      JSON.parse(fs.readFileSync(path.join(dir, "sessions.back.json"), "utf-8")),
    ).toMatchObject({
      oc_example_chat_id: [
        {
          controls: {
            modelId: "example-model-id",
            modeId: "example-mode-id",
            gatewayPermissionMode: "alwaysAsk",
          },
        },
      ],
    });
  });

  it("does not overwrite user-edited docs unless requested", () => {
    const agentsPath = path.join(dir, "AGENTS.md");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(agentsPath, "custom", "utf-8");

    installHomeTemplates({
      homeDir: dir,
      settingsPath: path.join(dir, "settings.json"),
      sessionsPath: path.join(dir, "sessions.json"),
      controlSocketPath: null,
    });
    expect(fs.readFileSync(agentsPath, "utf-8")).toBe("custom");

    installHomeTemplates({
      homeDir: dir,
      settingsPath: path.join(dir, "settings.json"),
      sessionsPath: path.join(dir, "sessions.json"),
      controlSocketPath: null,
      overwriteDocs: true,
    });
    expect(fs.readFileSync(agentsPath, "utf-8")).toContain("Humming operating guide");
  });
});
