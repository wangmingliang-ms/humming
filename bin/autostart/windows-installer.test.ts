import { describe, it, expect } from "vitest";
import { renderAutostartPs1, renderTaskXml } from "./windows-installer.js";

describe("renderAutostartPs1", () => {
  it("starts the gateway with no agent flag by default", () => {
    const text = renderAutostartPs1({ hummingCommand: "humming", agent: null });
    expect(text).toContain("humming gateway start");
    expect(text).not.toContain("--agent");
  });

  it("includes the agent flag when provided", () => {
    const text = renderAutostartPs1({ hummingCommand: "humming", agent: "claude" });
    expect(text).toContain("humming gateway start --agent claude");
  });
});

describe("renderTaskXml", () => {
  it("renders a BootTrigger task invoking pwsh with the ps1", () => {
    const xml = renderTaskXml({
      description: "Humming gateway autostart",
      pwshPath: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      ps1Path: "C:\\Users\\u\\.humming\\autostart\\humming-autostart.ps1",
      userId: "MACHINE\\u",
    });
    expect(xml).toContain("<BootTrigger>");
    expect(xml).toContain("<StartWhenAvailable>true</StartWhenAvailable>");
    expect(xml).toContain("pwsh.exe");
    expect(xml).toContain("humming-autostart.ps1");
    expect(xml).toContain("<UserId>MACHINE\\u</UserId>");
  });
});
