import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveTrustedVisionArtifact } from "../src/config/mcp/vision/vision-input-policy.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "floral-vision-"));
  const screenshots = join(root, "artifacts", "outbound", "floral_peekaboo");
  mkdirSync(screenshots, { recursive: true });
  const image = join(screenshots, "screen.png");
  writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return { root, screenshots, image };
}

describe("FLORAL vision input policy", () => {
  it("accepts a regular screenshot inside the configured FLORAL root", () => {
    const { screenshots, image } = fixture();
    const resolved = resolveTrustedVisionArtifact({ artifactPath: image, allowedRoot: screenshots });
    expect(resolved.absolutePath).toBe(image);
    expect(resolved.extension).toBe(".png");
  });

  it.each([
    "https://example.com/screen.png",
    "http://example.com/screen.png",
    "data:image/png;base64,AAAA",
  ])("rejects non-artifact input %s", (input) => {
    const { screenshots } = fixture();
    expect(() => resolveTrustedVisionArtifact({ artifactPath: input, allowedRoot: screenshots })).toThrow();
  });

  it("rejects files outside the configured root", () => {
    const { root, screenshots } = fixture();
    const outside = join(root, "outside.png");
    writeFileSync(outside, Buffer.from([1]));
    expect(() => resolveTrustedVisionArtifact({ artifactPath: outside, allowedRoot: screenshots })).toThrow(
      /outside/,
    );
  });

  it("rejects symlink inputs", () => {
    if (process.platform === "win32") return;
    const { screenshots, image } = fixture();
    const link = join(screenshots, "link.png");
    symlinkSync(image, link);
    expect(() => resolveTrustedVisionArtifact({ artifactPath: link, allowedRoot: screenshots })).toThrow(
      /symlink/,
    );
  });

  it("rejects hardlinked screenshot inputs", () => {
    const { screenshots, image } = fixture();
    const hardlink = join(screenshots, "hardlink.png");
    linkSync(image, hardlink);
    expect(() => resolveTrustedVisionArtifact({ artifactPath: image, allowedRoot: screenshots })).toThrow(
      /hardlink/,
    );
  });

  it("rejects unsupported file types", () => {
    const { screenshots } = fixture();
    const text = join(screenshots, "screen.txt");
    writeFileSync(text, "not an image");
    expect(() => resolveTrustedVisionArtifact({ artifactPath: text, allowedRoot: screenshots })).toThrow(
      /Unsupported/,
    );
  });
});
