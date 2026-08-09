import { linkSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveTrustedInboundVisionAttachment,
  resolveTrustedVisionArtifact,
} from "../src/config/mcp/vision/vision-input-policy.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "floral-vision-"));
  const screenshots = join(root, "artifacts", "outbound", "floral_peekaboo");
  const inbound = join(root, "data", "inbound", "feishu");
  mkdirSync(screenshots, { recursive: true });
  mkdirSync(inbound, { recursive: true });
  const image = join(screenshots, "screen.png");
  const attachment = join(inbound, "image-01.png");
  writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(attachment, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]));
  return { root, screenshots, inbound, image, attachment };
}

describe("FLORAL vision input policy", () => {
  it("accepts each image only inside its dedicated trust root", () => {
    const { screenshots, inbound, image, attachment } = fixture();
    expect(resolveTrustedVisionArtifact({ artifactPath: image, allowedRoot: screenshots }).absolutePath)
      .toBe(realpathSync(image));
    expect(resolveTrustedInboundVisionAttachment({
      artifactPath: attachment,
      allowedRoot: inbound,
    }).absolutePath).toBe(realpathSync(attachment));
  });

  it("keeps screenshot and inbound attachment trust domains isolated", () => {
    const { screenshots, inbound, image, attachment } = fixture();
    expect(() => resolveTrustedVisionArtifact({
      artifactPath: attachment,
      allowedRoot: screenshots,
    })).toThrow(/screenshot root/u);
    expect(() => resolveTrustedInboundVisionAttachment({
      artifactPath: image,
      allowedRoot: inbound,
    })).toThrow(/inbound attachment root/u);
  });

  it.each([
    "https://example.com/screen.png",
    "http://example.com/screen.png",
    "data:image/png;base64,AAAA",
  ])("rejects non-artifact input %s", (input) => {
    const { screenshots } = fixture();
    expect(() => resolveTrustedVisionArtifact({ artifactPath: input, allowedRoot: screenshots }))
      .toThrow();
  });

  it("rejects files outside the configured root", () => {
    const { root, screenshots } = fixture();
    const outside = join(root, "outside.png");
    writeFileSync(outside, Buffer.from([1]));
    expect(() => resolveTrustedVisionArtifact({ artifactPath: outside, allowedRoot: screenshots }))
      .toThrow(/outside/u);
  });

  it("rejects symlink inputs", () => {
    if (process.platform === "win32") return;
    const { inbound, attachment } = fixture();
    const link = join(inbound, "link.png");
    symlinkSync(attachment, link);
    expect(() => resolveTrustedInboundVisionAttachment({ artifactPath: link, allowedRoot: inbound }))
      .toThrow(/symlink/u);
  });

  it("rejects hardlinked inputs", () => {
    const { inbound, attachment } = fixture();
    const hardlink = join(inbound, "hardlink.png");
    linkSync(attachment, hardlink);
    expect(() => resolveTrustedInboundVisionAttachment({
      artifactPath: attachment,
      allowedRoot: inbound,
    })).toThrow(/hardlink/u);
  });

  it("rejects unsupported file types", () => {
    const { inbound } = fixture();
    const text = join(inbound, "attachment.txt");
    writeFileSync(text, "not an image");
    expect(() => resolveTrustedInboundVisionAttachment({ artifactPath: text, allowedRoot: inbound }))
      .toThrow(/Unsupported/u);
  });
});
