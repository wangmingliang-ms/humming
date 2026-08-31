import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sendControlRequestMock = vi.hoisted(() => vi.fn());
const listAgentSessionsMock = vi.hoisted(() => vi.fn());

vi.mock("../src/gateway/control-server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/gateway/control-server.js")>()),
  sendControlRequest: sendControlRequestMock,
}));
vi.mock("../src/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/index.js")>()),
  listAgentSessions: listAgentSessionsMock,
}));

import { buildProgram } from "./cli/program.js";

const HUMMING_ENV_KEYS = [
  "HUMMING_CHAT_ID",
  "HUMMING_THREAD_ID",
  "HUMMING_HOME",
  "HUMMING_APP_ID",
  "HUMMING_APP_SECRET",
  "HUMMING_PERMISSION_MODE",
];
let savedEnv: Record<string, string | undefined>;

let dir: string;

beforeEach(() => {
  savedEnv = Object.fromEntries(HUMMING_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of HUMMING_ENV_KEYS) delete process.env[key];
  sendControlRequestMock.mockReset();
  sendControlRequestMock.mockRejectedValue(new Error("gateway unavailable"));
  listAgentSessionsMock.mockReset();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "humming-session-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const key of HUMMING_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function newProgram() {
  return buildProgram({ version: "test", selfPath: path.join(dir, "self.js") });
}

async function parse(argv: readonly string[]) {
  const program = newProgram();
  await program.parseAsync(["node", "humming", ...argv]);
  return program;
}

describe("session list", () => {
  it("requires a resolvable cwd (no binding, no --cwd)", async () => {
    await expect(
      parse(["session", "list", "--home", dir, "--chat-id", "oc_x"]),
    ).rejects.toThrowError(/no cwd available/);
  });

  it("rejects an unknown option", async () => {
    await expect(
      parse(["session", "list", "--home", dir, "--cwd", dir, "--bogus"]),
    ).rejects.toMatchObject({ code: "commander.unknownOption" });
  });

  it("uses explicit --cwd only for the query without writing a binding", async () => {
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ bindings: {} }));
    listAgentSessionsMock.mockResolvedValue({
      supportsResume: true,
      supportsLoad: false,
      sessions: [],
    });

    await parse(["session", "list", "--home", dir, "--chat-id", "oc_x", "--cwd", dir]);

    expect(listAgentSessionsMock).toHaveBeenCalledWith(expect.objectContaining({ cwd: dir }));
    expect(JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf-8"))).toEqual({
      bindings: {},
    });
  });
});

describe("session bind", () => {
  it("requires --chat-id (or $HUMMING_CHAT_ID)", async () => {
    await expect(
      parse(["session", "bind", "--home", dir, "--session-id", "s1"]),
    ).rejects.toThrowError(/requires --chat-id/);
  });

  it("requires --session-id", async () => {
    await expect(
      parse(["session", "bind", "--home", dir, "--chat-id", "oc_x"]),
    ).rejects.toMatchObject({ code: "commander.missingMandatoryOptionValue" });
  });

  it("does not accept --cwd (only binds within the current chat repo)", async () => {
    await expect(
      parse([
        "session",
        "bind",
        "--home",
        dir,
        "--chat-id",
        "oc_x",
        "--session-id",
        "s1",
        "--cwd",
        dir,
      ]),
    ).rejects.toMatchObject({ code: "commander.unknownOption" });
  });

  it("uses the current topic-effective repository to find the requested session", async () => {
    const chatRepo = path.join(dir, "chat-repo");
    const topicRepo = path.join(dir, "topic-repo");
    fs.mkdirSync(chatRepo);
    fs.mkdirSync(topicRepo);
    fs.writeFileSync(
      path.join(dir, "settings.json"),
      JSON.stringify({
        bindings: { oc_x: { cwd: chatRepo, topics: { omt_x: { cwd: topicRepo } } } },
      }),
    );
    listAgentSessionsMock.mockResolvedValue({
      supportsResume: true,
      supportsLoad: false,
      sessions: [{ sessionId: "s1", cwd: topicRepo }],
    });
    sendControlRequestMock.mockResolvedValue({
      ok: true,
      result: { bound: true, sessionId: "s1" },
    });

    await parse([
      "session",
      "bind",
      "--home",
      dir,
      "--chat-id",
      "oc_x",
      "--thread-id",
      "omt_x",
      "--session-id",
      "s1",
    ]);

    expect(listAgentSessionsMock).toHaveBeenCalledWith(expect.objectContaining({ cwd: topicRepo }));
  });
});

describe("session capabilities/models/modes/permissions", () => {
  for (const sub of ["capabilities", "models", "modes", "permissions"]) {
    it(`\`session ${sub}\` does not accept --agent`, async () => {
      await expect(
        parse(["session", sub, "--home", dir, "--chat-id", "oc_x", "--agent", "claude"]),
      ).rejects.toMatchObject({ code: "commander.unknownOption" });
    });

    it(`\`session ${sub}\` requires chat scope`, async () => {
      await expect(parse(["session", sub, "--home", dir])).rejects.toThrowError(
        /requires --chat-id/,
      );
    });

    it(`\`session ${sub}\` fails when the gateway is unreachable`, async () => {
      await expect(
        parse(["session", sub, "--home", dir, "--chat-id", "oc_x"]),
      ).rejects.toThrowError(/could not reach the gateway control socket/);
    });
  }
});

describe("session configure", () => {
  it("requires at least one profile field", async () => {
    await expect(
      parse(["session", "configure", "--home", dir, "--chat-id", "oc_x"]),
    ).rejects.toThrowError(/at least one profile field/);
  });

  it("rejects a message with no profile field, pointing at `session send`", async () => {
    await expect(
      parse(["session", "configure", "--home", dir, "--chat-id", "oc_x", "--message", "hello"]),
    ).rejects.toThrowError(/session send/);
  });

  it("rejects conflicting message sources", async () => {
    await expect(
      parse([
        "session",
        "configure",
        "--home",
        dir,
        "--chat-id",
        "oc_x",
        "--mode",
        "agent",
        "--message",
        "hi",
        "--message-stdin",
      ]),
    ).rejects.toMatchObject({ code: "commander.conflictingOption" });
  });

  it("fails when the gateway is unreachable, once a profile field is present", async () => {
    await expect(
      parse(["session", "configure", "--home", dir, "--chat-id", "oc_x", "--mode", "agent"]),
    ).rejects.toThrowError(/could not reach the gateway control socket/);
  });

  it("requires --chat-id (or $HUMMING_CHAT_ID)", async () => {
    await expect(
      parse(["session", "configure", "--home", dir, "--mode", "agent"]),
    ).rejects.toThrowError(/requires --chat-id/);
  });

  it("--model auto is accepted as the explicit clear sentinel", async () => {
    await expect(
      parse(["session", "configure", "--home", dir, "--chat-id", "oc_x", "--model", "auto"]),
    ).rejects.toThrowError(/could not reach the gateway control socket/);
  });

  it("rejects a malformed --config assignment", async () => {
    await expect(
      parse([
        "session",
        "configure",
        "--home",
        dir,
        "--chat-id",
        "oc_x",
        "--config",
        "no-equals-sign",
      ]),
    ).rejects.toThrowError(/--config requires/);
  });

  it("forwards bindingCwd only for an explicit Agent and cwd handoff", async () => {
    sendControlRequestMock.mockResolvedValue({ ok: true, result: { applied: true } });

    await parse([
      "session",
      "configure",
      "--home",
      dir,
      "--chat-id",
      "oc_x",
      "--thread-id",
      "omt_x",
      "--agent",
      "claude",
      "--cwd",
      dir,
    ]);

    expect(sendControlRequestMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        method: "configureSession",
        params: expect.objectContaining({
          chatId: "oc_x",
          threadId: "omt_x",
          bindingCwd: dir,
          targetAgent: expect.objectContaining({ cwd: dir }),
        }),
      }),
    );
  });

  it("does not forward bindingCwd for an Agent handoff without explicit cwd", async () => {
    fs.writeFileSync(
      path.join(dir, "settings.json"),
      JSON.stringify({ bindings: { oc_x: { cwd: dir } } }),
    );
    sendControlRequestMock.mockResolvedValue({ ok: true, result: { applied: true } });

    await parse(["session", "configure", "--home", dir, "--chat-id", "oc_x", "--agent", "claude"]);

    const request = sendControlRequestMock.mock.calls[0]?.[1];
    expect(request).toMatchObject({
      method: "configureSession",
      params: { targetAgent: { cwd: dir } },
    });
    expect(request).not.toMatchObject({ params: { bindingCwd: expect.anything() } });
  });
});

describe("session send", () => {
  it("requires exactly one message source", async () => {
    await expect(
      parse(["session", "send", "--home", dir, "--chat-id", "oc_x"]),
    ).rejects.toThrowError(/exactly one message source/);
  });

  it("rejects conflicting message sources", async () => {
    await expect(
      parse([
        "session",
        "send",
        "--home",
        dir,
        "--chat-id",
        "oc_x",
        "--message",
        "hi",
        "--message-file",
        "x",
      ]),
    ).rejects.toMatchObject({ code: "commander.conflictingOption" });
  });

  it("requires --chat-id (or $HUMMING_CHAT_ID)", async () => {
    await expect(parse(["session", "send", "--home", dir, "--message", "hi"])).rejects.toThrowError(
      /requires --chat-id/,
    );
  });

  it("fails when the gateway is unreachable", async () => {
    await expect(
      parse(["session", "send", "--home", dir, "--chat-id", "oc_x", "--message", "hi"]),
    ).rejects.toThrowError(/could not reach the gateway control socket/);
  });

  it("rejects an empty --message-file", async () => {
    const file = path.join(dir, "empty.md");
    fs.writeFileSync(file, "   \n");
    await expect(
      parse(["session", "send", "--home", dir, "--chat-id", "oc_x", "--message-file", file]),
    ).rejects.toThrowError(/must not be empty/);
  });
});
