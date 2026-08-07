import { describe, expect, it } from "vitest";
import {
  buildFeishuMarkdownPost,
  hasFeishuRenderableMarkdown,
  sanitizeFeishuMarkdown,
  serializeFeishuMarkdownPostIfSafe,
} from "../src/transport/feishu/feishu-rich-text.js";

describe("Feishu rich text", () => {
  it("detects Markdown while leaving ordinary text alone", () => {
    expect(hasFeishuRenderableMarkdown("hello world")).toBe(false);
    expect(hasFeishuRenderableMarkdown("**bold** and `code`")).toBe(true);
    expect(hasFeishuRenderableMarkdown("## heading\n- item")).toBe(true);
    expect(hasFeishuRenderableMarkdown("| A | B |\n|---|---|\n| 1 | 2 |")).toBe(true);
  });

  it("builds post/md and neutralizes Feishu-only egress markup", () => {
    expect(buildFeishuMarkdownPost("**ok**")).toEqual({
      zh_cn: { content: [[{ tag: "md", text: "**ok**" }]] },
    });
    const sanitized = sanitizeFeishuMarkdown(
      '<at user_id="all"></at>\n![secret](img_v3_secret)\n[link](https://example.com)',
    );
    expect(sanitized).toContain("\\<at");
    expect(sanitized).toContain("\\![secret]");
    expect(sanitized).toContain("[link](https://example.com)");
  });

  it("falls back when a post exceeds the safe rich-text envelope", () => {
    expect(serializeFeishuMarkdownPostIfSafe("**small**")).toBeTypeOf("string");
    expect(serializeFeishuMarkdownPostIfSafe("x".repeat(40_000))).toBeUndefined();
  });
});
