import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { fileConfigSchema } from "../../bin/cli/config/schema.js";
import { SettingsBindingStore } from "./settings-binding-store.js";
import { repositoryCwdSchema } from "./binding-schema.js";
import { SettingsBindingMutationError as BindingEntryMutationError } from "./index.js";
import { SettingsBindingMutationError as RootMutationError } from "../index.js";
import type { RepositoryScope } from "./binding-store.js";

let dir: string;
let settingsPath: string;

const chatScope: RepositoryScope = { kind: "chat" };
const topicScope = (threadId: string): RepositoryScope => ({ kind: "topic", threadId });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "humming-settings-"));
  settingsPath = path.join(dir, "settings.json");
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

function readJson(): Record<string, unknown> {
  return z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(fs.readFileSync(settingsPath, "utf-8")));
}

describe("SettingsBindingStore", () => {
  it("reads legacy chat-only bindings", async () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ bindings: { oc_a: { cwd: "/repo/a" } } }));
    const store = new SettingsBindingStore(settingsPath);

    expect(await store.get("oc_a")).toMatchObject({ chatId: "oc_a", cwd: "/repo/a" });
  });

  it("ignores bindings with empty chat cwd, empty topic cwd, or empty topics", async () => {
    const invalidBindings = {
      bindings: {
        oc_empty_chat: { cwd: "" },
        oc_empty_topic: { topics: { omt_1: { cwd: "" } } },
        oc_empty_topics: { cwd: "/repo/a", topics: {} },
      },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(invalidBindings));
    const store = new SettingsBindingStore(settingsPath);

    expect(fileConfigSchema.safeParse(invalidBindings).success).toBe(false);
    expect(await store.list()).toEqual([]);
  });

  it("rejects an empty chat cwd without writing settings", async () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ bindings: { oc_a: { cwd: "/repo/a" } } }));
    const contentBeforeSet = fs.readFileSync(settingsPath, "utf-8");
    const modifiedBeforeSet = fs.statSync(settingsPath).mtimeMs;
    const renameSync = vi.spyOn(fs, "renameSync");
    const store = new SettingsBindingStore(settingsPath);

    await expect(store.set("oc_a", chatScope, "")).rejects.toMatchObject({
      name: "BindingValidationError",
      scope: chatScope,
      cwd: "",
    });

    expect(renameSync).not.toHaveBeenCalled();
    expect(fs.readFileSync(settingsPath, "utf-8")).toBe(contentBeforeSet);
    expect(fs.statSync(settingsPath).mtimeMs).toBe(modifiedBeforeSet);
  });

  it("rejects an empty topic cwd without writing settings", async () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ bindings: { oc_a: { cwd: "/repo/a" } } }));
    const contentBeforeSet = fs.readFileSync(settingsPath, "utf-8");
    const modifiedBeforeSet = fs.statSync(settingsPath).mtimeMs;
    const renameSync = vi.spyOn(fs, "renameSync");
    const store = new SettingsBindingStore(settingsPath);
    const scope = topicScope("omt_1");

    await expect(store.set("oc_a", scope, "")).rejects.toMatchObject({
      name: "BindingValidationError",
      scope,
      cwd: "",
    });

    expect(renameSync).not.toHaveBeenCalled();
    expect(fs.readFileSync(settingsPath, "utf-8")).toBe(contentBeforeSet);
    expect(fs.statSync(settingsPath).mtimeMs).toBe(modifiedBeforeSet);
  });

  it("requires repository cwd values to be absolute paths", () => {
    const validCwd = path.resolve(dir, "repository");

    expect(repositoryCwdSchema.safeParse(validCwd).success).toBe(true);
    for (const relativeCwd of [".", "repo", "", "   "]) {
      expect(repositoryCwdSchema.safeParse(relativeCwd).success).toBe(false);
    }
  });

  it("exports SettingsBindingMutationError from both public entry points", () => {
    expect(BindingEntryMutationError).toBe(RootMutationError);
    expect(
      new RootMutationError("delete", settingsPath, "bindings must be a complete valid snapshot"),
    ).toBeInstanceOf(BindingEntryMutationError);
  });

  it("preserves other top-level keys on write", async () => {
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        credentials: { appId: "cli_x", appSecret: "s" },
        runtime: { permissionMode: "alwaysAsk" },
      }),
    );
    const store = new SettingsBindingStore(settingsPath);
    await store.set("oc_a", chatScope, "/repo/a");

    const root = readJson();
    expect(root["credentials"]).toEqual({ appId: "cli_x", appSecret: "s" });
    expect(root["runtime"]).toEqual({ permissionMode: "alwaysAsk" });
    expect(root["bindings"]).toEqual({ oc_a: { cwd: "/repo/a" } });
  });

  it("deletes one chat binding while preserving other chat bindings and top-level keys", async () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ credentials: { appId: "cli_x" } }));
    const store = new SettingsBindingStore(settingsPath);
    await store.set("oc_a", chatScope, "/repo/a");
    await store.set("oc_b", chatScope, "/repo/b");
    await store.delete("oc_a", chatScope);

    expect(await store.get("oc_a")).toBeNull();
    expect(await store.get("oc_b")).toMatchObject({ cwd: "/repo/b" });
    expect(readJson()["credentials"]).toEqual({ appId: "cli_x" });
  });

  it("ignores unknown extra fields on a binding entry", async () => {
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ bindings: { oc_z: { cwd: "/repo/z", agent: "codex" } } }),
    );
    const store = new SettingsBindingStore(settingsPath);

    const got = await store.get("oc_z");
    expect(got).toMatchObject({ cwd: "/repo/z" });
    expect(got).not.toHaveProperty("agentLabel");
  });

  it("rejects set and delete against malformed JSON without changing its bytes", async () => {
    const malformed = '{"credentials":{"appId":"app"},"bindings":';
    fs.writeFileSync(settingsPath, malformed);
    const store = new SettingsBindingStore(settingsPath);

    await expect(store.set("oc_a", chatScope, "/repo/a")).rejects.toMatchObject({
      name: "SettingsBindingMutationError",
      operation: "set",
    });
    expect(fs.readFileSync(settingsPath, "utf-8")).toBe(malformed);

    await expect(store.delete("oc_a", chatScope)).rejects.toMatchObject({
      name: "SettingsBindingMutationError",
      operation: "delete",
    });
    expect(fs.readFileSync(settingsPath, "utf-8")).toBe(malformed);
  });

  it("rejects a mutation when any existing binding is schema-invalid without changing bytes", async () => {
    const invalid = JSON.stringify({
      credentials: { appId: "app", appSecret: "secret" },
      runtime: { permissionMode: "alwaysAsk" },
      bindings: { oc_invalid: { cwd: "" }, oc_valid: { cwd: "/repo/valid" } },
    });
    fs.writeFileSync(settingsPath, invalid);
    const store = new SettingsBindingStore(settingsPath);

    await expect(store.set("oc_other", chatScope, "/repo/other")).rejects.toMatchObject({
      name: "SettingsBindingMutationError",
      operation: "set",
    });
    expect(fs.readFileSync(settingsPath, "utf-8")).toBe(invalid);
    await expect(store.delete("oc_valid", chatScope)).rejects.toMatchObject({
      name: "SettingsBindingMutationError",
      operation: "delete",
    });
    expect(fs.readFileSync(settingsPath, "utf-8")).toBe(invalid);
  });

  it("keeps a successfully set binding in the cache after corruption", async () => {
    const store = new SettingsBindingStore(settingsPath);
    await store.set("oc_a", chatScope, "/repo/a");
    fs.writeFileSync(settingsPath, "{ half written");

    expect(await store.list()).toMatchObject([{ chatId: "oc_a", cwd: "/repo/a" }]);
  });

  it("does not revive a successfully deleted binding after corruption", async () => {
    const store = new SettingsBindingStore(settingsPath);
    await store.set("oc_a", chatScope, "/repo/a");
    await store.set("oc_b", chatScope, "/repo/b");
    await store.delete("oc_a", chatScope);
    fs.writeFileSync(settingsPath, "{ half written");

    expect(await store.list()).toMatchObject([{ chatId: "oc_b", cwd: "/repo/b" }]);
  });

  it("preloads a valid snapshot during init for a subsequent corrupt read", async () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ bindings: { oc_a: { cwd: "/repo/a" } } }));
    const store = new SettingsBindingStore(settingsPath);
    await store.init();
    fs.writeFileSync(settingsPath, "{ half written");

    expect(await store.list()).toMatchObject([{ chatId: "oc_a", cwd: "/repo/a" }]);
  });

  it("starts with an empty last-known-good snapshot when settings is corrupt", async () => {
    fs.writeFileSync(settingsPath, "{ half written");
    const store = new SettingsBindingStore(settingsPath);

    await store.init();
    expect(await store.list()).toEqual([]);
    expect(store.isReadable()).toBe(false);
  });

  it("lists all chat bindings", async () => {
    const store = new SettingsBindingStore(settingsPath);
    await store.set("oc_a", chatScope, "/repo/a");
    await store.set("oc_b", topicScope("omt_1"), "/repo/topic-b");

    expect((await store.list()).map((binding) => binding.chatId).sort()).toEqual(["oc_a", "oc_b"]);
  });

  it("writes chat and topic bindings together", async () => {
    const store = new SettingsBindingStore(settingsPath);
    await store.set("oc_a", chatScope, "/repo/a");
    await store.set("oc_a", topicScope("omt_1"), "/repo/topic-a");

    expect(readJson()["bindings"]).toEqual({
      oc_a: { cwd: "/repo/a", topics: { omt_1: { cwd: "/repo/topic-a" } } },
    });
    expect(await store.get("oc_a")).toMatchObject({
      chatId: "oc_a",
      cwd: "/repo/a",
      topics: { omt_1: { cwd: "/repo/topic-a" } },
    });
  });

  it("supports a topic-only binding without a chat cwd", async () => {
    const store = new SettingsBindingStore(settingsPath);
    await store.set("oc_a", topicScope("omt_1"), "/repo/topic-a");

    expect(readJson()["bindings"]).toEqual({
      oc_a: { topics: { omt_1: { cwd: "/repo/topic-a" } } },
    });
    expect(await store.get("oc_a")).toMatchObject({
      chatId: "oc_a",
      topics: { omt_1: { cwd: "/repo/topic-a" } },
    });
    expect(await store.get("oc_a")).not.toHaveProperty("cwd");
  });

  it("updates one topic without affecting sibling topics", async () => {
    const store = new SettingsBindingStore(settingsPath);
    await store.set("oc_a", topicScope("omt_1"), "/repo/topic-a");
    await store.set("oc_a", topicScope("omt_2"), "/repo/topic-b");
    await store.set("oc_a", topicScope("omt_1"), "/repo/topic-a-next");

    expect(readJson()["bindings"]).toEqual({
      oc_a: {
        topics: {
          omt_1: { cwd: "/repo/topic-a-next" },
          omt_2: { cwd: "/repo/topic-b" },
        },
      },
    });
  });

  it("deletes one topic without affecting sibling topics", async () => {
    const store = new SettingsBindingStore(settingsPath);
    await store.set("oc_a", topicScope("omt_1"), "/repo/topic-a");
    await store.set("oc_a", topicScope("omt_2"), "/repo/topic-b");
    await store.delete("oc_a", topicScope("omt_1"));

    expect(readJson()["bindings"]).toEqual({
      oc_a: { topics: { omt_2: { cwd: "/repo/topic-b" } } },
    });
  });

  it("deletes a chat cwd while retaining topic bindings", async () => {
    const store = new SettingsBindingStore(settingsPath);
    await store.set("oc_a", chatScope, "/repo/a");
    await store.set("oc_a", topicScope("omt_1"), "/repo/topic-a");
    await store.delete("oc_a", chatScope);

    expect(readJson()["bindings"]).toEqual({
      oc_a: { topics: { omt_1: { cwd: "/repo/topic-a" } } },
    });
  });

  it("does not write when deleting a missing chat cwd", async () => {
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ bindings: { oc_a: { topics: { omt_1: { cwd: "/repo/topic-a" } } } } }),
    );
    const contentBeforeDelete = fs.readFileSync(settingsPath, "utf-8");
    const modifiedBeforeDelete = fs.statSync(settingsPath).mtimeMs;
    const renameSync = vi.spyOn(fs, "renameSync");
    const store = new SettingsBindingStore(settingsPath);

    await store.delete("oc_a", chatScope);

    expect(renameSync).not.toHaveBeenCalled();
    expect(fs.readFileSync(settingsPath, "utf-8")).toBe(contentBeforeDelete);
    expect(fs.statSync(settingsPath).mtimeMs).toBe(modifiedBeforeDelete);
  });

  it("does not write for a missing topic and retains its newest strict snapshot", async () => {
    const initial = { bindings: { oc_a: { topics: { omt_1: { cwd: "/repo/topic-a" } } } } };
    const current = { bindings: { oc_a: { topics: { omt_2: { cwd: "/repo/topic-b" } } } } };
    fs.writeFileSync(settingsPath, JSON.stringify(initial));
    const store = new SettingsBindingStore(settingsPath);
    await store.init();

    const replacementPath = path.join(dir, "settings.next.json");
    fs.writeFileSync(replacementPath, JSON.stringify(current));
    fs.renameSync(replacementPath, settingsPath);
    const contentBeforeDelete = fs.readFileSync(settingsPath, "utf-8");
    const modifiedBeforeDelete = fs.statSync(settingsPath).mtimeMs;
    const renameSync = vi.spyOn(fs, "renameSync");

    await store.delete("oc_a", topicScope("omt_missing"));

    expect(renameSync).not.toHaveBeenCalled();
    expect(fs.readFileSync(settingsPath, "utf-8")).toBe(contentBeforeDelete);
    expect(fs.statSync(settingsPath).mtimeMs).toBe(modifiedBeforeDelete);

    fs.writeFileSync(settingsPath, "{ half written");
    expect(await store.get("oc_a")).toMatchObject({
      topics: { omt_2: { cwd: "/repo/topic-b" } },
    });
  });

  it("retains the newest strict snapshot after a no-op deletion of an unknown chat", async () => {
    const initial = { bindings: { oc_a: { cwd: "/repo/a" } } };
    const current = { bindings: { oc_b: { cwd: "/repo/b" } } };
    fs.writeFileSync(settingsPath, JSON.stringify(initial));
    const store = new SettingsBindingStore(settingsPath);
    await store.init();

    const replacementPath = path.join(dir, "settings.next.json");
    fs.writeFileSync(replacementPath, JSON.stringify(current));
    fs.renameSync(replacementPath, settingsPath);
    const contentBeforeDelete = fs.readFileSync(settingsPath, "utf-8");
    const modifiedBeforeDelete = fs.statSync(settingsPath).mtimeMs;
    const renameSync = vi.spyOn(fs, "renameSync");

    await store.delete("oc_missing", chatScope);

    expect(renameSync).not.toHaveBeenCalled();
    expect(fs.readFileSync(settingsPath, "utf-8")).toBe(contentBeforeDelete);
    expect(fs.statSync(settingsPath).mtimeMs).toBe(modifiedBeforeDelete);

    fs.writeFileSync(settingsPath, "{ half written");
    expect(await store.list()).toMatchObject([{ chatId: "oc_b", cwd: "/repo/b" }]);
  });

  it("removes the chat entry when its final scope is deleted", async () => {
    const store = new SettingsBindingStore(settingsPath);
    await store.set("oc_a", topicScope("omt_1"), "/repo/topic-a");
    await store.delete("oc_a", topicScope("omt_1"));

    expect(readJson()["bindings"]).toEqual({});
    expect(await store.get("oc_a")).toBeNull();
  });
});

describe("fileConfigSchema bindings", () => {
  it("accepts legacy, mixed, and topic-only bindings", () => {
    const parsed = fileConfigSchema.parse({
      bindings: {
        oc_legacy: { cwd: "/repo/legacy" },
        oc_mixed: { cwd: "/repo/mixed", topics: { omt_1: { cwd: "/repo/topic" } } },
        oc_topic_only: { topics: { omt_2: { cwd: "/repo/topic-only" } } },
      },
    });

    expect(parsed.bindings).toEqual({
      oc_legacy: { cwd: "/repo/legacy" },
      oc_mixed: { cwd: "/repo/mixed", topics: { omt_1: { cwd: "/repo/topic" } } },
      oc_topic_only: { topics: { omt_2: { cwd: "/repo/topic-only" } } },
    });
  });

  it("rejects empty bindings", () => {
    expect(() => fileConfigSchema.parse({ bindings: { oc_empty: {} } })).toThrow();
    expect(() =>
      fileConfigSchema.parse({ bindings: { oc_empty_topics: { topics: {} } } }),
    ).toThrow();
    expect(() =>
      fileConfigSchema.parse({ bindings: { oc_empty_topics: { cwd: "/repo/a", topics: {} } } }),
    ).toThrow();
  });

  it("rejects relative repository cwd values", () => {
    expect(() => fileConfigSchema.parse({ bindings: { oc_relative: { cwd: "." } } })).toThrow(
      "repository binding cwd must be an absolute path",
    );
  });
});
