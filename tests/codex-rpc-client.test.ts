import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CodexRuntimeError } from "../src/agent/codex-errors.js";
import { CodexRpcClient } from "../src/agent/codex-rpc-client.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url));

function createClient(scenario: string): CodexRpcClient {
  return new CodexRpcClient({
    command: process.execPath,
    args: [fixture, scenario],
    requestTimeoutMs: 5_000,
  });
}

describe("CodexRpcClient", () => {
  it("reports malformed JSON without losing the initialize response", async () => {
    const client = createClient("malformed");
    const protocolError = new Promise<CodexRuntimeError>((resolve) => {
      client.once("protocolError", (error: CodexRuntimeError) => resolve(error));
    });

    try {
      await client.start();
      await client.initialize({ name: "test", title: "Test", version: "0.1.0" });
      await expect(protocolError).resolves.toMatchObject({ kind: "protocol" });
    } finally {
      await client.stop();
    }
  });

  it("rejects pending requests when the child exits", async () => {
    const client = createClient("normal");
    try {
      await client.start();
      await client.initialize({ name: "test", title: "Test", version: "0.1.0" });
      await expect(client.request("test/exit", {})).rejects.toMatchObject({
        kind: "process_exit",
      });
    } finally {
      await client.stop();
    }
  });
});
