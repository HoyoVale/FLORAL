import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadFeishuLocalMedia } from "../src/transport/feishu/feishu-media.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

describe("Feishu local media validation", () => {
  it("loads supported image and generic file media", async () => {
    const dir = await mkdtemp(join(tmpdir(), "floral-feishu-media-"));
    temporary.push(dir);
    const image = join(dir, "screen.png");
    const file = join(dir, "report.md");
    await writeFile(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(file, "# report");

    const loadedImage = await loadFeishuLocalMedia({ kind: "image", localPath: image });
    expect(loadedImage.fileName).toBe("screen.png");
    expect(loadedImage.byteLength).toBe(4);

    const loadedFile = await loadFeishuLocalMedia({
      kind: "file",
      localPath: file,
      fileName: "report.md",
    });
    expect(loadedFile.bytes.toString("utf8")).toBe("# report");
  });

  it("rejects unsupported image extensions and unsafe file names", async () => {
    const dir = await mkdtemp(join(tmpdir(), "floral-feishu-media-"));
    temporary.push(dir);
    const image = join(dir, "screen.svg");
    await writeFile(image, "<svg/>");

    await expect(loadFeishuLocalMedia({
      kind: "image",
      localPath: image,
    })).rejects.toThrow("Unsupported Feishu image extension");

    await expect(loadFeishuLocalMedia({
      kind: "file",
      localPath: image,
      fileName: "../escape.svg",
    })).rejects.toThrow("path separators");
  });
});
