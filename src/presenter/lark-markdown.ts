/**
 * Convert agent-emitted markdown into Lark's `post` rich-text payload.
 *
 * Lark's `post` element zoo has several blind spots — most notably no
 * inline-code tag and uneven coverage of nested inline styles. The
 * `md` tag, however, accepts a markdown string and renders it natively
 * with full inline support (bold, italic, codespan, links, lists,
 * blockquotes, fenced code, ...).
 *
 * Strategy: walk the `marked` token tree to **rebuild normalized markdown**.
 * Prose blocks are coalesced into md rows, while fenced code blocks are kept
 * in their own rows. Hermes Agent does the same isolation because Feishu can
 * swallow content that follows a fenced block when everything lives inside one
 * large md element.
 *
 * Lark post payload shape per:
 * https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/im-v1/message-content-description/create_json
 */

import { marked, type Token, type Tokens } from "marked";

/** Soft cap on a single chunk's markdown source length. Lark's post body
 *  itself can be large; this keeps any single reply within IM limits and
 *  avoids one runaway code block blocking the whole reply. */
const MAX_MARKDOWN_CHUNK = 4000;

/** Lark's `md` tag refuses to render fenced blocks that omit a language.
 *  Default to `plaintext` so a bare ``` fence still ends up as a code box. */
const DEFAULT_CODE_LANG = "plaintext";

interface PostElMd {
  tag: "md";
  text: string;
}

type PostParagraph = PostElMd[];

export interface PostPayload {
  title?: string;
  content: PostParagraph[];
}

/**
 * Parse `text` as markdown and return a Lark post payload. Fenced code blocks
 * are isolated into separate rows so Feishu clients do not hide trailing prose.
 */
export function markdownToPost(text: string): PostPayload {
  const tokens = marked.lexer(text);
  const rows = renderPostRows(tokens);
  return { content: rows.length > 0 ? rows : [[{ tag: "md", text: "" }]] };
}

/**
 * Split a markdown blob into chunks no longer than `limit` characters,
 * preferring to break on paragraph boundaries (`\n\n`) and falling back
 * to single newlines. Code-fence boundaries are preferred when they sit
 * close to the limit so we don't split a fenced block in half.
 */
export function splitMarkdown(text: string, limit = MAX_MARKDOWN_CHUNK): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf("\n```\n", limit);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf("\n\n", limit);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt <= 0) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, "");
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

// ---- Block-level renderer ---------------------------------------------------

interface RenderedBlock {
  text: string;
  isolate: boolean;
}

function renderPostRows(tokens: Token[]): PostParagraph[] {
  const rows: PostParagraph[] = [];
  let prose: string[] = [];

  const flushProse = (): void => {
    const text = prose.join("\n\n").trim();
    if (text) rows.push([{ tag: "md", text }]);
    prose = [];
  };

  for (const token of tokens) {
    const rendered = renderBlock(token);
    if (rendered === undefined) continue;
    if (rendered.isolate) {
      flushProse();
      rows.push([{ tag: "md", text: rendered.text }]);
    } else {
      prose.push(rendered.text);
    }
  }

  flushProse();
  return rows;
}

function renderBlock(token: Token): RenderedBlock | undefined {
  switch (token.type) {
    case "heading": {
      const heading = token as Tokens.Heading;
      const hashes = "#".repeat(Math.max(1, Math.min(6, heading.depth)));
      return proseBlock(`${hashes} ${renderInlineTokens(heading.tokens ?? [])}`);
    }
    case "paragraph": {
      const para = token as Tokens.Paragraph;
      const inline = renderInlineTokens(para.tokens ?? []);
      return inline ? proseBlock(inline) : undefined;
    }
    case "code": {
      const code = token as Tokens.Code;
      const lang = (code.lang ?? "").trim() || DEFAULT_CODE_LANG;
      return isolatedBlock(`\`\`\`${lang}\n${code.text}\n\`\`\``);
    }
    case "hr":
      return proseBlock("---");
    case "blockquote":
    case "list": {
      // Lark's md tag renders both natively. Keep marked's raw form;
      // strip trailing whitespace so consecutive blocks don't double-space.
      const raw = (token as { raw: string }).raw.replace(/\s+$/, "");
      return raw ? proseBlock(raw) : undefined;
    }
    case "table": {
      // Feishu post-type md has poor table support. Render tables as isolated
      // fixed-width code blocks so content stays visible and aligned.
      if (isTable(token)) {
        return isolatedBlock(`\`\`\`${DEFAULT_CODE_LANG}\n${tableToText(token)}\n\`\`\``);
      }
      return undefined;
    }
    case "space":
      return undefined;
    case "html": {
      const html = (token as Tokens.HTML).text.trim();
      return html ? proseBlock(html) : undefined;
    }
    default: {
      const raw = (token as { raw?: string }).raw?.trim();
      return raw ? proseBlock(raw) : undefined;
    }
  }
}

function proseBlock(text: string): RenderedBlock {
  return { text, isolate: false };
}

function isolatedBlock(text: string): RenderedBlock {
  return { text, isolate: true };
}

function isTable(token: Token): token is Tokens.Table {
  return token.type === "table" && Array.isArray((token as Tokens.Table).header);
}

// ---- Inline renderer --------------------------------------------------------

function renderInlineTokens(tokens: Token[]): string {
  let out = "";
  for (const t of tokens) out += renderInline(t);
  return out;
}

function renderInline(token: Token): string {
  switch (token.type) {
    case "text": {
      const text = token as Tokens.Text;
      if (text.tokens?.length) return renderInlineTokens(text.tokens);
      return text.text ?? "";
    }
    case "strong":
      return `**${renderInlineTokens((token as Tokens.Strong).tokens ?? [])}**`;
    case "em":
      return `*${renderInlineTokens((token as Tokens.Em).tokens ?? [])}*`;
    case "del":
      return `~~${renderInlineTokens((token as Tokens.Del).tokens ?? [])}~~`;
    case "codespan":
      return `\`${(token as Tokens.Codespan).text}\``;
    case "link": {
      const link = token as Tokens.Link;
      const label = renderInlineTokens(link.tokens ?? []) || link.text || link.href;
      return `[${label}](${link.href})`;
    }
    case "image": {
      // Agents emit URL-based images; post can only render uploaded
      // image_keys. Render as a link so the user can still reach it.
      const img = token as Tokens.Image;
      const label = img.text || "图片";
      return `[图片 ${label}](${img.href})`;
    }
    case "br":
      return "\n";
    case "escape":
      // Re-add the backslash so the md tag's parser preserves the literal.
      return `\\${(token as Tokens.Escape).text}`;
    case "html":
      return (token as Tokens.HTML).text;
    default: {
      const raw = (token as { raw?: string }).raw;
      return raw ?? "";
    }
  }
}

// ---- Helpers ----------------------------------------------------------------

function tableToText(table: Tokens.Table): string {
  const rows = [table.header.map((c) => c.text), ...table.rows.map((r) => r.map((c) => c.text))];
  const colCount = table.header.length;
  const colWidths = new Array<number>(colCount).fill(0);
  for (const row of rows) {
    for (let i = 0; i < colCount; i++) {
      const cell = row[i] ?? "";
      const w = colWidths[i] ?? 0;
      if (cell.length > w) colWidths[i] = cell.length;
    }
  }
  const padCell = (cell: string | undefined, i: number): string =>
    (cell ?? "").padEnd(colWidths[i] ?? 0);

  const lines = rows.map((row) =>
    Array.from({ length: colCount }, (_, i) => padCell(row[i], i)).join(" | "),
  );
  const separator = colWidths.map((w) => "-".repeat(w)).join("-+-");
  lines.splice(1, 0, separator);
  return lines.join("\n");
}
