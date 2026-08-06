import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Vitest repository scope", () => {
  it("collects only FLORAL test files", async () => {
    const config = await readFile(
      new URL("../vitest.config.ts", import.meta.url),
      "utf8",
    );

    expect(config).toContain('include: ["tests/**/*.test.ts"]');
    expect(config).toContain('"data/**"');
    expect(config).toContain('"dist/**"');
    expect(config).toContain('"node_modules/**"');
  });

  it("forces normal and watch commands through the scoped config", async () => {
    const pkg = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      scripts?: Record<string, string>;
    };

    expect(pkg.scripts?.test).toBe(
      "vitest run --config vitest.config.ts",
    );
    expect(pkg.scripts?.["test:watch"]).toBe(
      "vitest --config vitest.config.ts",
    );
  });
});
