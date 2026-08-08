import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CodexAppServerRuntime } from "../src/agent/codex-app-server.js";

const fixture = fileURLToPath(
  new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url),
);

describe("Codex thread management adapter", () => {
  it("lists cwd-scoped threads without resuming them and archives by opaque id", async () => {
    const runtime = new CodexAppServerRuntime({
      command: process.execPath,
      args: [fixture, "thread-management"],
      requestTimeoutMs: 5_000,
      defaultModel: undefined,
    });

    try {
      await runtime.start();
      await expect(runtime.listThreads({
        cwd: process.cwd(),
        limit: 20,
      })).resolves.toEqual([
        {
          id: "thr_project_newer",
          preview: "Newest project thread with extra spacing",
          createdAt: 200,
          updatedAt: 250,
        },
        {
          id: "thr_project_older",
          preview: "Older project thread",
          createdAt: 100,
          updatedAt: 150,
        },
      ]);
      await expect(runtime.archiveThread("thr_project_older")).resolves.toBeUndefined();
    } finally {
      await runtime.stop();
    }
  });
});
