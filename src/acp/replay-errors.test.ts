import { describe, it, expect } from "vitest";
import { AgentReplayUnsupportedError } from "./replay-errors.js";

describe("AgentReplayUnsupportedError", () => {
  it("carries the sessionId and a descriptive message", () => {
    const err = new AgentReplayUnsupportedError("sess-1");
    expect(err).toBeInstanceOf(Error);
    expect(err.sessionId).toBe("sess-1");
    expect(err.message).toContain("loadSession");
  });
});
