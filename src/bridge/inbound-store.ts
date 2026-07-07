import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MAX_ATTACHMENT_NAME_CHARS = 128;
const FALLBACK_KEY_CHARS = 10;
export const DEFAULT_INBOUND_MAX_AGE_MS = 24 * 60 * 60_000;
export const DEFAULT_INBOUND_DIR = path.join(os.homedir(), ".humming", "inbound");

/** Build the local on-disk path for an inbound attachment resource. */
export function inboundResourcePath(inboundDir: string, messageId: string, name: string): string {
  return path.join(
    inboundDir,
    safeAttachmentName(messageId, "message"),
    safeAttachmentName(name, messageId),
  );
}

/**
 * Convert a Lark-provided filename into a safe single path segment.
 *
 * Path separators and control characters are removed before choosing a basename;
 * empty / dot-only names fall back to `attachment-<shortKey>`. Long names are
 * capped while preserving the extension so local tools still recognise them.
 */
export function safeAttachmentName(rawName: string, fallbackKey: string): string {
  const withoutControls = rawName.replace(/[\u0000-\u001f\u007f]/gu, "");
  const basename = path.posix.basename(withoutControls.replaceAll("\\", "/")).trim();
  const safeBase = basename === "" || basename === "." || basename === ".." ? null : basename;
  const candidate = safeBase ?? `attachment-${shortKey(fallbackKey)}`;
  return capAttachmentName(candidate);
}

/** Return true when an entry with `mtimeMs` should be swept. */
export function isExpired(mtimeMs: number, nowMs: number, maxAgeMs: number): boolean {
  return nowMs - mtimeMs > maxAgeMs;
}

export interface SweepInboundDirOptions {
  readonly nowMs?: number;
  readonly maxAgeMs?: number;
}

/**
 * Best-effort age-based cleanup for inbound attachment directories.
 *
 * @throws when reading or deleting the inbound directory fails for reasons other
 *         than it not existing. Callers should log and continue.
 */
export async function sweepInboundDir(
  inboundDir: string,
  opts: SweepInboundDirOptions = {},
): Promise<void> {
  const nowMs = opts.nowMs ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_INBOUND_MAX_AGE_MS;
  let entries: readonly string[];
  try {
    entries = await fs.readdir(inboundDir);
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") return;
    throw err;
  }

  await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(inboundDir, entry);
      const stat = await fs.stat(fullPath);
      if (!isExpired(stat.mtimeMs, nowMs, maxAgeMs)) return;
      await fs.rm(fullPath, { recursive: true, force: true });
    }),
  );
}

function shortKey(key: string): string {
  const normalized = key.replace(/[^A-Za-z0-9_-]/gu, "");
  return normalized.length > 0 ? normalized.slice(0, FALLBACK_KEY_CHARS) : "unknown";
}

function capAttachmentName(name: string): string {
  if (name.length <= MAX_ATTACHMENT_NAME_CHARS) return name;

  const ext = path.extname(name);
  if (ext.length === 0 || ext.length >= MAX_ATTACHMENT_NAME_CHARS) {
    return name.slice(0, MAX_ATTACHMENT_NAME_CHARS);
  }

  const stemLength = MAX_ATTACHMENT_NAME_CHARS - ext.length;
  return `${name.slice(0, stemLength)}${ext}`;
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
