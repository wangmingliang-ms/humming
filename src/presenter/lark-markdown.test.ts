import { describe, it, expect } from "vitest";
import { stripCardImageMarkdown } from "./lark-markdown.js";

describe("stripCardImageMarkdown", () => {
  it("removes a file:// image span that Lark would reject as an image_key", () => {
    const text = "before ![gen](file:///tmp/humming-gen.png) after";
    expect(stripCardImageMarkdown(text)).toBe("before  after");
  });

  it("removes http(s) and empty-alt image spans", () => {
    expect(stripCardImageMarkdown("a ![](https://x.test/p.png) b")).toBe("a  b");
    expect(stripCardImageMarkdown("![alt](https://x.test/p.jpg)")).toBe("");
  });

  it("removes multiple image spans", () => {
    const text = "![](file:///a.png) mid ![](https://x.test/b.png)";
    expect(stripCardImageMarkdown(text)).toBe(" mid ");
  });

  it("leaves ordinary links untouched", () => {
    const text = "see [docs](https://x.test/docs)";
    expect(stripCardImageMarkdown(text)).toBe(text);
  });

  it("does not trim or collapse surrounding whitespace", () => {
    const text = "line1\n\n![](file:///a.png)\n\nline2";
    // Only the image span is removed; blank lines/layout are preserved so a
    // streamed card body stays stable across patches.
    expect(stripCardImageMarkdown(text)).toBe("line1\n\n\n\nline2");
  });

  it("is a no-op for text without images", () => {
    expect(stripCardImageMarkdown("just text")).toBe("just text");
  });
});
