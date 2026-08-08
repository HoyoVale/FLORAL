import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CodexAppServerRuntime } from "../src/agent/codex-app-server.js";

const fixture = fileURLToPath(
  new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url),
);

describe("Codex full-access turn override", () => {
  it("uses the installed app-server dangerFullAccess wire shape only for the requested run", async () => {
    const runtime = new CodexAppServerRuntime({
      command: process.execPath,
      args: [fixture, "full-access-turn"],
      requestTimeoutMs: 5_000,
      defaultModel: undefined,
      approvalPolicy: "untrusted",
      sandboxMode: "workspace-write",
      approvalsReviewer: "user",
    });

    try {
      await runtime.start();
      const result = await runtime.run({
        text: "trusted full-access task",
        cwd: process.cwd(),
        approvalPolicy: "untrusted",
        sandboxMode: "danger-full-access",
        approvalsReviewer: "user",
        approvalHandler: async () => "approve",
      });
      expect(result.finalText).toBe("full access configured");
    } finally {
      await runtime.stop();
    }
  });
});
