/**
 * Shared lifecycle handoff: arm an independent coordinator process before
 * asking the Gateway to quiesce for a `stop` or `restart`. Used by both the
 * `gateway stop`/`gateway restart` commands and the post-`update` restart.
 */
import path from "node:path";
import process from "node:process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  armLifecycleCoordinator,
  buildLifecycleTransaction,
  type LifecycleIntent,
  type LifecycleTransaction,
} from "../lifecycle-coordinator.js";
import {
  gatewayPidPath,
  isAlive,
  isUserSystemdAvailable,
  readPid,
  gatewayUnitName,
  ProcessControlError,
} from "../process-control.js";

const LIFECYCLE_READY_TO_EXIT_MS = 20_000;
const LIFECYCLE_OLD_PID_EXIT_MS = 30_000;
const LIFECYCLE_RESTART_READY_MS = 45_000;

export interface LaunchForHandoff {
  readonly spawnArgv: readonly string[];
  readonly workingDirectory: string;
}

/** Resolve the running gateway PID, checking the systemd unit first when available. */
export function resolveRunningGatewayPid(homeDir: string): number | null {
  const pidPath = gatewayPidPath(homeDir);
  const persisted = readPid(pidPath);
  if (persisted !== null && isAlive(persisted)) return persisted;
  if (process.platform === "linux" && isUserSystemdAvailable()) {
    const shown = spawnSync(
      "systemctl",
      ["--user", "show", gatewayUnitName(homeDir), "-p", "MainPID", "--value"],
      { encoding: "utf-8" },
    );
    const pid = Number((shown.stdout ?? "").trim());
    if (shown.status === 0 && Number.isInteger(pid) && pid > 0 && isAlive(pid)) {
      fs.mkdirSync(homeDir, { recursive: true });
      fs.writeFileSync(pidPath, `${pid}\n`, "utf-8");
      return pid;
    }
  }
  return null;
}

/**
 * Arm an independent lifecycle coordinator before asking the Gateway to
 * quiesce for `stop`/`restart`.
 *
 * @throws {ProcessControlError} when no gateway is currently running.
 */
export function handoffLifecycle(
  homeDir: string,
  intent: LifecycleIntent,
  launch: LaunchForHandoff,
): LifecycleTransaction {
  const oldPid = resolveRunningGatewayPid(homeDir);
  if (oldPid === null || !isAlive(oldPid)) {
    throw new ProcessControlError("gateway is not running");
  }
  const now = Date.now();
  const transaction = buildLifecycleTransaction({
    id: randomUUID(),
    intent,
    home: homeDir,
    oldPid,
    launch: {
      spawnArgv: [...launch.spawnArgv],
      workingDirectory: launch.workingDirectory,
      savedAt: new Date(now).toISOString(),
    },
    now,
    readyToExitMs: LIFECYCLE_READY_TO_EXIT_MS,
    oldPidExitMs: LIFECYCLE_OLD_PID_EXIT_MS,
    restartReadyMs: LIFECYCLE_RESTART_READY_MS,
  });
  armLifecycleCoordinator(transaction, {
    platform: process.platform,
    systemdAvailable: isUserSystemdAvailable(),
    nodePath: process.execPath,
    coordinatorPath: path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "lifecycle-coordinator.js",
    ),
  });
  return transaction;
}
