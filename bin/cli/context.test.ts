import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadCliBase, resolveSessionRepoTarget } from "./context.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "humming-cli-context-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function createRepo(name: string): string {
  const repo = path.join(dir, name);
  fs.mkdirSync(repo);
  return repo;
}

function writeSettings(settings: object): void {
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(settings));
}

describe("resolveSessionRepoTarget", () => {
  it("uses a topic binding before its chat binding", () => {
    const chatRepo = createRepo("chat-repo");
    const topicRepo = createRepo("topic-repo");
    writeSettings({
      bindings: {
        oc_chat: {
          cwd: chatRepo,
          topics: { omt_topic: { cwd: topicRepo } },
        },
      },
    });

    const target = resolveSessionRepoTarget(loadCliBase({ home: dir }), {
      chatId: "oc_chat",
      threadId: "omt_topic",
    });

    expect(target.cwd).toBe(topicRepo);
  });

  it("falls back through runtime cwd to reception cwd", () => {
    const runtimeRepo = createRepo("runtime-repo");
    const receptionRepo = createRepo("reception-repo");
    writeSettings({ runtime: { cwd: runtimeRepo, unboundCwd: receptionRepo } });

    const runtimeTarget = resolveSessionRepoTarget(loadCliBase({ home: dir }), {
      chatId: "oc_unbound",
      threadId: null,
    });
    expect(runtimeTarget.cwd).toBe(runtimeRepo);

    writeSettings({ runtime: { unboundCwd: receptionRepo } });
    const receptionTarget = resolveSessionRepoTarget(loadCliBase({ home: dir }), {
      chatId: "oc_unbound",
      threadId: null,
    });
    expect(receptionTarget.cwd).toBe(receptionRepo);
  });

  it("does not use a historical SessionRecord cwd as a repository binding", () => {
    const receptionRepo = createRepo("reception-repo");
    const historicalRepo = createRepo("historical-repo");
    writeSettings({ runtime: { unboundCwd: receptionRepo } });
    fs.writeFileSync(
      path.join(dir, "sessions.json"),
      JSON.stringify({
        oc_chat: [
          {
            chatId: "oc_chat",
            threadId: "omt_topic",
            sessionId: "old-session",
            agentCommand: "agent",
            agentArgs: [],
            cwd: historicalRepo,
            createdAt: 1,
            updatedAt: 2,
          },
        ],
      }),
    );

    const target = resolveSessionRepoTarget(loadCliBase({ home: dir }), {
      chatId: "oc_chat",
      threadId: "omt_topic",
    });

    expect(target.cwd).toBe(receptionRepo);
  });
});
