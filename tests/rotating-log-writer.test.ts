import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RotatingLogWriter } from "../src/service/rotating-log-writer.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("rotating log writer", () => {
  it("writes ordered chunks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "floral-log-"));
    directories.push(directory);
    const path = join(directory, "service.log");
    const writer = new RotatingLogWriter(path, 1024, 2);
    await Promise.all([writer.write("first\n"), writer.write("second\n")]);
    await writer.close();
    expect(await readFile(path, "utf8")).toBe("first\nsecond\n");
  });

  it("rotates before exceeding the active-file limit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "floral-log-"));
    directories.push(directory);
    const path = join(directory, "service.log");
    const writer = new RotatingLogWriter(path, 1024, 2);
    await writer.write("a".repeat(900));
    await writer.write("b".repeat(300));
    await writer.close();
    expect((await readFile(`${path}.1`, "utf8")).length).toBe(900);
    expect((await readFile(path, "utf8")).length).toBe(300);
  });

  it("rejects unsafe rotation settings", () => {
    expect(() => new RotatingLogWriter("/tmp/test.log", 100, 1)).toThrow();
    expect(() => new RotatingLogWriter("/tmp/test.log", 1024, 0)).toThrow();
  });
});
