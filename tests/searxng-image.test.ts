import { describe, expect, it } from "vitest";
import { parsePinnedSearxngImage } from "../src/search/searxng-image.js";

const digest = "a".repeat(64);

describe("parsePinnedSearxngImage", () => {
  it("accepts the official image pinned by digest", () => {
    const image = `docker.io/searxng/searxng@sha256:${digest}`;
    expect(parsePinnedSearxngImage(`services:\n  searxng:\n    image: ${image}\n`)).toBe(image);
  });

  it("rejects mutable latest tags", () => {
    expect(() => parsePinnedSearxngImage(
      "services:\n  searxng:\n    image: docker.io/searxng/searxng:latest\n",
    )).toThrow(/pinned by sha256 digest/);
  });

  it("rejects unapproved image repositories", () => {
    expect(() => parsePinnedSearxngImage(
      `services:\n  searxng:\n    image: example.invalid/searxng@sha256:${digest}\n`,
    )).toThrow(/docker.io\/searxng\/searxng/);
  });
});
