import { describe, it, expect, vi } from "vitest";
import { spawnAndLoadAgent } from "./agent-process.js";

describe("spawnAndLoadAgent", () => {
  it("rejects when the agent cannot be spawned/initialized", async () => {
    const logger = {
      child: () => logger,
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    };
    await expect(
      spawnAndLoadAgent(
        {
          command: "false",
          args: [],
          cwd: process.cwd(),
          env: {},
          client: {} as never,
          logger: logger as never,
        },
        "sess-x",
      ),
    ).rejects.toBeInstanceOf(Error);
  });
});
