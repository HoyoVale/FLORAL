import { describe, expect, it } from "vitest";
import { splitQqText } from "../src/transport/qq/qq-text.js";

describe("QQ text chunking", () => {
  it("returns one chunk for a short reply", () => {
    expect(splitQqText("hello", {
      maxCharacters: 10,
      maxChunks: 4,
    })).toEqual(["hello"]);
  });

  it("splits at natural whitespace when possible", () => {
    expect(splitQqText("alpha beta gamma", {
      maxCharacters: 11,
      maxChunks: 4,
    })).toEqual(["alpha beta", "gamma"]);
  });

  it("counts Unicode code points instead of UTF-16 units", () => {
    const chunks = splitQqText("😀😀😀😀😀", {
      maxCharacters: 3,
      maxChunks: 3,
    });
    expect(chunks).toEqual(["😀😀😀", "😀😀"]);
  });

  it("truncates deterministically when the chunk budget is exhausted", () => {
    const chunks = splitQqText("x".repeat(100), {
      maxCharacters: 20,
      maxChunks: 2,
      truncationSuffix: "[cut]",
    });
    expect(chunks).toHaveLength(2);
    expect(Array.from(chunks[1] ?? "")).toHaveLength(20);
    expect(chunks[1]?.endsWith("[cut]")).toBe(true);
  });

  it("provides a bounded placeholder for empty model output", () => {
    expect(splitQqText(" \n ", {
      maxCharacters: 20,
      maxChunks: 1,
    })).toEqual(["（空回复）"]);
  });
  it("uses semantic paragraph boundaries for mobile-sized long replies", () => {
    const paragraphA = "甲".repeat(760);
    const paragraphB = "乙".repeat(760);
    const chunks = splitQqText(`${paragraphA}\n\n${paragraphB}`, {
      maxCharacters: 1_800,
      maxChunks: 4,
    });

    expect(chunks).toEqual([paragraphA, paragraphB]);
  });

  it("keeps full configured capacity when a reply really needs all chunks", () => {
    const text = "字".repeat(6_900);
    const chunks = splitQqText(text, {
      maxCharacters: 1_800,
      maxChunks: 4,
    });

    expect(chunks).toHaveLength(4);
    expect(chunks.every((chunk) => Array.from(chunk).length <= 1_800)).toBe(true);
    expect(chunks.join("")).toBe(text);
  });

});
