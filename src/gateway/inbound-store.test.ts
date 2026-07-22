import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_INBOUND_DIR,
  inboundResourcePath,
  isExpired,
  safeAttachmentName,
} from "./inbound-store.js";

describe("inbound-store helpers", () => {
  it("keeps the default inbound directory under ~/.humming/inbound", () => {
    expect(DEFAULT_INBOUND_DIR).toBe(path.join(os.homedir(), ".humming", "inbound"));
  });

  it("sanitizes path traversal and control characters from attachment names", () => {
    expect(safeAttachmentName("../secret\u0000/report.pdf", "fallback_key")).toBe("report.pdf");
    expect(safeAttachmentName("C:\\temp\\demo.txt", "fallback_key")).toBe("demo.txt");
  });

  it("synthesizes a fallback name for empty or dot attachment names", () => {
    expect(safeAttachmentName("", "file_key_abcdef")).toBe("attachment-file_key_a");
    expect(safeAttachmentName("..", "file_key_abcdef")).toBe("attachment-file_key_a");
  });

  it("caps very long names while preserving the extension", () => {
    const safe = safeAttachmentName(`${"a".repeat(160)}.pdf`, "fallback_key");
    expect(safe.length).toBeLessThanOrEqual(128);
    expect(safe.endsWith(".pdf")).toBe(true);
  });

  it("builds resource paths under the message-id namespace", () => {
    expect(inboundResourcePath("/tmp/inbound", "om_1", "../a.pdf")).toBe(
      path.join("/tmp/inbound", "om_1", "a.pdf"),
    );
  });

  it("detects expired entries using mtime age", () => {
    expect(isExpired(1_000, 1_000 + 24 * 60 * 60_000 + 1, 24 * 60 * 60_000)).toBe(true);
    expect(isExpired(1_000, 1_000 + 24 * 60 * 60_000, 24 * 60 * 60_000)).toBe(false);
  });
});
