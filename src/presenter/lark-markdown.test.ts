import { describe, expect, it } from "vitest";
import { markdownToPost, splitMarkdown } from "./lark-markdown.js";

function rowTexts(post: ReturnType<typeof markdownToPost>): string[] {
  return post.content.map((row) => row.map((item) => item.text).join(""));
}

describe("lark markdown post rendering", () => {
  it("renders simple markdown into a single md row", () => {
    const post = markdownToPost("Hello **world**");

    expect(rowTexts(post)).toEqual(["Hello **world**"]);
  });

  it("isolates fenced code blocks into their own post rows", () => {
    const post = markdownToPost("Before\n\n```ts\nconst x = 1;\n```\n\nAfter");

    expect(rowTexts(post)).toEqual(["Before", "```ts\nconst x = 1;\n```", "After"]);
  });

  it("keeps prose between multiple fenced code blocks visible", () => {
    const post = markdownToPost(
      'Intro\n\n```\nalpha\n```\n\nMiddle\n\n```json\n{"ok":true}\n```\n\nDone',
    );

    expect(rowTexts(post)).toEqual([
      "Intro",
      "```plaintext\nalpha\n```",
      "Middle",
      '```json\n{"ok":true}\n```',
      "Done",
    ]);
  });

  it("still splits long markdown without cutting obvious paragraph boundaries", () => {
    const chunks = splitMarkdown("A\n\nB\n\nC", 4);

    expect(chunks).toEqual(["A\n\nB", "C"]);
  });
});
