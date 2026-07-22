/**
 * Prompt hydrator — the effectful gateway-layer counterpart of the pure
 * interpreter. Turns interpreter {@link PromptSegment}s into ACP
 * {@link acp.ContentBlock}s, downloading referenced images/resources along the
 * way.
 *
 * Images are inlined as ACP `image` blocks because vision-capable agents can
 * inspect them directly. Non-image attachments are downloaded to local temp
 * files and sent as ACP `resource_link` blocks so prompts stay small and the
 * local agent can dereference bytes lazily via `file://`.
 */

import { pathToFileURL } from "node:url";
import type * as acp from "@agentclientprotocol/sdk";
import type { PromptSegment } from "../interpreter/lark-interpreter.js";
import type { LarkLogger } from "../logger/logger.js";
import { DEFAULT_INBOUND_DIR, inboundResourcePath } from "./inbound-store.js";

/** Max inline image size; larger images fall back to a text placeholder to
 *  avoid blowing the stdio pipe / being rejected by the model. 10 MiB. */
export const MAX_INLINE_IMAGE_BYTES = 10 * 1024 * 1024;

/** Narrow capability the hydrator needs; {@link LarkHttpClient} satisfies it. */
export interface ImageDownloader {
  downloadMessageImage(
    messageId: string,
    imageKey: string,
  ): Promise<{ bytes: Buffer; mimeType: string }>;
}

/** Narrow non-image attachment capability; {@link LarkHttpClient} satisfies it. */
export interface ResourceDownloader {
  /**
   * Download a non-image message resource straight to `destPath`.
   *
   * @throws when Lark download or disk streaming fails.
   */
  downloadMessageResourceToFile(
    messageId: string,
    fileKey: string,
    destPath: string,
  ): Promise<{ mimeType: string | null; size: number }>;
}

export interface HydrateDeps {
  readonly downloader: ImageDownloader;
  readonly resourceDownloader: ResourceDownloader;
  readonly logger: LarkLogger;
  /** Injectable for tests; defaults to {@link MAX_INLINE_IMAGE_BYTES}. */
  readonly maxInlineImageBytes?: number;
  /** Injectable for tests; defaults to {@link DEFAULT_INBOUND_DIR}. */
  readonly inboundDir?: string;
}

/**
 * Text fallback for an image that couldn't be inlined. Byte-for-byte identical
 * to the interpreter's pre-feature placeholder, guaranteeing zero regression.
 */
export function imagePlaceholder(messageId: string, imageKey: string): string {
  return `[图片 (message_id=${messageId}, image_key=${imageKey})]`;
}

/** Text fallback for a resource that couldn't be downloaded to disk. */
export function resourcePlaceholder(
  segment: Extract<PromptSegment, { kind: "resource-ref" }>,
): string {
  return `[${segment.label} — 附件下载失败 (file_key=${segment.fileKey})]`;
}

/**
 * Hydrate interpreter segments into ACP content blocks. `text` segments pass
 * through unchanged; `image-ref` segments become `image` blocks;
 * `resource-ref` segments become local-file `resource_link` blocks. Output order
 * strictly matches input order. Never throws — a single attachment failure is
 * logged and downgraded to a placeholder.
 */
export async function hydratePrompt(
  segments: readonly PromptSegment[],
  deps: HydrateDeps,
): Promise<acp.ContentBlock[]> {
  const maxBytes = deps.maxInlineImageBytes ?? MAX_INLINE_IMAGE_BYTES;
  return Promise.all(segments.map((segment) => hydrateSegment(segment, deps, maxBytes)));
}

async function hydrateSegment(
  segment: PromptSegment,
  deps: HydrateDeps,
  maxBytes: number,
): Promise<acp.ContentBlock> {
  switch (segment.kind) {
    case "text":
      return { type: "text", text: segment.text };
    case "image-ref":
      return downloadImageBlock(segment.messageId, segment.imageKey, deps, maxBytes);
    case "resource-ref":
      return downloadResourceBlock(segment, deps);
  }
}

async function downloadImageBlock(
  messageId: string,
  imageKey: string,
  deps: HydrateDeps,
  maxBytes: number,
): Promise<acp.ContentBlock> {
  try {
    const { bytes, mimeType } = await deps.downloader.downloadMessageImage(messageId, imageKey);
    if (bytes.length > maxBytes) {
      deps.logger.warn(
        { messageId, imageKey, bytes: bytes.length, maxBytes },
        "inbound image too large — falling back to text placeholder",
      );
      return { type: "text", text: imagePlaceholder(messageId, imageKey) };
    }
    return { type: "image", data: bytes.toString("base64"), mimeType };
  } catch (err) {
    deps.logger.warn(
      { err, messageId, imageKey },
      "inbound image download failed — falling back to text placeholder",
    );
    return { type: "text", text: imagePlaceholder(messageId, imageKey) };
  }
}

async function downloadResourceBlock(
  segment: Extract<PromptSegment, { kind: "resource-ref" }>,
  deps: HydrateDeps,
): Promise<acp.ContentBlock> {
  const inboundDir = deps.inboundDir ?? DEFAULT_INBOUND_DIR;
  const destPath = inboundResourcePath(inboundDir, segment.messageId, segment.name);
  try {
    const { mimeType, size } = await deps.resourceDownloader.downloadMessageResourceToFile(
      segment.messageId,
      segment.fileKey,
      destPath,
    );
    return {
      type: "resource_link",
      uri: pathToFileURL(destPath).href,
      name: segment.name,
      description: segment.label,
      ...(mimeType ? { mimeType } : {}),
      ...(size > 0 ? { size } : {}),
    };
  } catch (err) {
    deps.logger.warn(
      { err, messageId: segment.messageId, fileKey: segment.fileKey, name: segment.name },
      "inbound resource download failed — falling back to text placeholder",
    );
    return { type: "text", text: resourcePlaceholder(segment) };
  }
}
