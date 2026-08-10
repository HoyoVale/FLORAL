import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CodexRuntimeError } from "../src/agent/codex-errors.js";
import {
  buildCodexSpawnEnvironment,
  CodexRpcClient,
  resolveCodexSpawnCommand,
} from "../src/agent/codex-rpc-client.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url));

function createClient(scenario: string): CodexRpcClient {
  return new CodexRpcClient({
    command: process.execPath,
    args: [fixture, scenario],
    requestTimeoutMs: 5_000,
  });
}

describe("CodexRpcClient", () => {
  it("canonicalizes an absolute macOS executable before app-server spawn", async () => {
    const observed: string[] = [];
    await expect(resolveCodexSpawnCommand("/Users/test/.local/bin/codex", {
      platform: "darwin",
      resolveRealpath: async (path) => {
        observed.push(path);
        return "/Users/test/.codex/packages/standalone/releases/0.146.1/bin/codex";
      },
    })).resolves.toBe("/Users/test/.codex/packages/standalone/releases/0.146.1/bin/codex");
    expect(observed).toEqual(["/Users/test/.local/bin/codex"]);
  });

  it("resolves a bare macOS command through the child PATH before canonicalizing it", async () => {
    await expect(resolveCodexSpawnCommand("codex", {
      platform: "darwin",
      env: { PATH: "/Users/test/.local/bin:/usr/bin" },
      resolvePathCommand: async (command, env) => {
        expect(command).toBe("codex");
        expect(env.PATH).toContain(".local/bin");
        return "/Users/test/.local/bin/codex";
      },
      resolveRealpath: async () => "/Users/test/.codex/releases/0.146.1/bin/codex",
    })).resolves.toBe("/Users/test/.codex/releases/0.146.1/bin/codex");
  });

  it("preserves PATH lookup and non-macOS executable behavior", async () => {
    const unexpected = async (): Promise<string> => {
      throw new Error("realpath should not be called");
    };
    await expect(resolveCodexSpawnCommand("relative/codex", {
      platform: "darwin",
      resolvePathCommand: async () => undefined,
      resolveRealpath: unexpected,
    })).resolves.toBe("relative/codex");
    await expect(resolveCodexSpawnCommand("C:\\tools\\codex.exe", {
      platform: "win32",
      resolveRealpath: unexpected,
    })).resolves.toBe("C:\\tools\\codex.exe");
  });

  it("pins the canonical macOS binary directory for helper re-execution", () => {
    const command = "/Users/test/.codex/releases/0.146.1/bin/codex";
    expect(buildCodexSpawnEnvironment(command, {
      PATH: "/usr/bin:/Users/test/.local/bin",
      CODEX_COMMAND: "codex",
      KEEP_ME: "yes",
    }, "darwin")).toEqual({
      PATH: "/Users/test/.codex/releases/0.146.1/bin:/usr/bin:/Users/test/.local/bin",
      CODEX_COMMAND: command,
      KEEP_ME: "yes",
    });
  });

  it("preserves the configured path when macOS realpath resolution fails", async () => {
    await expect(resolveCodexSpawnCommand("/missing/codex", {
      platform: "darwin",
      resolveRealpath: async () => {
        throw new Error("missing");
      },
    })).resolves.toBe("/missing/codex");
  });

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

  it("publishes a batched server request after the preceding response continuation", async () => {
    const client = createClient("normal");
    const order: string[] = [];
    const observedRequest = new Promise<void>((resolve) => {
      client.once("serverRequest", (request) => {
        order.push("server-request");
        expect(request).toMatchObject({
          id: "batched_request_1",
          method: "test/serverRequest",
          params: { source: "same-stdout-chunk" },
        });
        client.respond(request.id, { accepted: true });
        resolve();
      });
    });

    try {
      await client.start();
      await client.initialize({ name: "test", title: "Test", version: "0.1.0" });
      await client.request("test/batched-server-request", {}).then(() => {
        order.push("response-continuation");
      });
      await observedRequest;
      expect(order).toEqual(["response-continuation", "server-request"]);
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
