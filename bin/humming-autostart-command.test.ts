import { describe, it, expect } from "vitest";
import { formatAutostartReport } from "./cli/commands/autostart.js";

describe("formatAutostartReport", () => {
  it("describes an install", () => {
    const msg = formatAutostartReport({
      kind: "installed",
      mechanism: "systemd",
      path: "/home/u/.config/systemd/user/x.service",
    });
    expect(msg).toContain("installed");
    expect(msg).toContain("systemd");
  });

  it("describes a skip", () => {
    const msg = formatAutostartReport({ kind: "skipped", reason: "unsupported platform: darwin" });
    expect(msg).toContain("skipped");
    expect(msg).toContain("darwin");
  });
});
