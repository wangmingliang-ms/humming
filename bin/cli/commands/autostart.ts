/**
 * `humming autostart` — install (idempotently) OS-native boot autostart for
 * the gateway. Wraps the autostart module; also invoked by init/update.
 */
import process from "node:process";
import { Command } from "commander";
import { resolveHomeDir } from "../config/load.js";
import { ensureAutostartForHome } from "../../autostart/runtime.js";
import type { AutostartReport } from "../../autostart/index.js";
import type { GlobalOptions } from "../context.js";

/** Human-readable one-liner for a report. */
export function formatAutostartReport(report: AutostartReport): string {
  switch (report.kind) {
    case "installed":
      return `autostart installed (${report.mechanism}) at ${report.path}`;
    case "already-current":
      return `autostart already current (${report.mechanism}) at ${report.path}`;
    case "skipped":
      return `autostart skipped: ${report.reason}`;
  }
}

export interface RegisterAutostartOptions {
  readonly selfPath: string;
}

export function registerAutostartCommand(
  program: Command,
  opts: RegisterAutostartOptions,
): void {
  program
    .command("autostart")
    .description("install OS-native boot autostart for the gateway")
    .action(function (this: Command) {
      const globals = this.optsWithGlobals<GlobalOptions>();
      const homeDir = resolveHomeDir(globals.home);
      const report = ensureAutostartForHome(homeDir, opts.selfPath);
      process.stdout.write(`${formatAutostartReport(report)}\n`);
    });
}
