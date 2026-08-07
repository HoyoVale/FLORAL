import { describe, expect, it } from "vitest";
import { presentQqText } from "../src/transport/qq/qq-presentation.js";

describe("presentQqText", () => {
  it("turns common Markdown into readable QQ plain text", () => {
    const result = presentQqText([
      "## **FLORAL 项目是什么**",
      "",
      "- 使用 `Codex app-server`",
      "- 参考 [README](https://example.test/readme)",
      "",
      "> 安全边界保持不变。",
    ].join("\n"));

    expect(result).toBe([
      "FLORAL 项目是什么",
      "",
      "• 使用 Codex app-server",
      "• 参考 README (https://example.test/readme)",
      "",
      "› 安全边界保持不变。",
    ].join("\n"));
    expect(result).not.toContain("**");
    expect(result).not.toContain("`");
  });

  it("does not corrupt code-style identifiers", () => {
    expect(presentQqText("`__init__` and foo_bar_baz")).toBe(
      "__init__ and foo_bar_baz",
    );
  });

  it("keeps fenced code content while dropping fence markers", () => {
    const result = presentQqText("```text\nthread=active\nrun=idle\n```");
    expect(result).toBe("thread=active\nrun=idle");
  });

  it("turns Markdown tables into compact text rows", () => {
    const result = presentQqText([
      "| 项目 | 状态 |",
      "| --- | --- |",
      "| Codex | ready |",
    ].join("\n"));
    expect(result).toBe("项目 · 状态\nCodex · ready");
  });
});
