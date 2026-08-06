import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CodexAppServerRuntime } from "../src/agent/codex-app-server.js";
import { CodexRuntimeError } from "../src/agent/codex-errors.js";
import type { AgentEvent } from "../src/core/types.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url));

function createRuntime(scenario: string, timeoutMs = 5_000): CodexAppServerRuntime {
  return new CodexAppServerRuntime({
    command: process.execPath,
    args: [fixture, scenario],
    requestTimeoutMs: timeoutMs,
    defaultModel: undefined,
  });
}

describe("CodexAppServerRuntime", () => {
  it("runs a new thread and trusts item/completed as final text", async () => {
    const runtime = createRuntime("normal");
    const events: AgentEvent[] = [];
    try {
      await runtime.start();
      const result = await runtime.run(
        { text: "hello", cwd: process.cwd() },
        (event) => events.push(event),
      );

      expect(result).toEqual({ threadId: "thr_new", finalText: "authoritative final" });
      expect(events.some((event) => event.type === "assistant.delta")).toBe(true);
      expect(events.at(-1)?.type).toBe("run.completed");
    } finally {
      await runtime.stop();
    }
  });

  it("resumes an existing thread before starting a turn", async () => {
    const runtime = createRuntime("resume");
    try {
      await runtime.start();
      const result = await runtime.run({
        threadId: "thr_existing",
        text: "continue",
        cwd: process.cwd(),
      });
      expect(result).toEqual({ threadId: "thr_existing", finalText: "resumed final" });
    } finally {
      await runtime.stop();
    }
  });

  it("starts a fresh thread when a persisted thread is no longer available", async () => {
    const runtime = createRuntime("stale-resume");
    try {
      await runtime.start();
      const result = await runtime.run({
        threadId: "thr_deleted",
        text: "recover",
        cwd: process.cwd(),
      });
      expect(result).toEqual({
        threadId: "thr_new",
        finalText: "recovered final",
      });
    } finally {
      await runtime.stop();
    }
  });

  it("declines approvals by default", async () => {
    const runtime = createRuntime("approval");
    const events: AgentEvent[] = [];
    try {
      await runtime.start();
      const result = await runtime.run(
        { text: "run command", cwd: process.cwd() },
        (event) => events.push(event),
      );

      expect(result.finalText).toBe("approval declined safely");
      expect(events.some((event) => event.type === "approval.requested")).toBe(true);
    } finally {
      await runtime.stop();
    }
  });


  it("emits bounded MCP tool lifecycle events", async () => {
    const runtime = createRuntime("mcp-tool");
    const events: AgentEvent[] = [];
    try {
      await runtime.start();
      const result = await runtime.run(
        { text: "search", cwd: process.cwd() },
        (event) => events.push(event),
      );

      expect(result.finalText).toBe("search complete");
      expect(events).toContainEqual({
        type: "tool.started",
        name: "floral_search/searxng_web_search",
        detail: {
          server: "floral_search",
          tool: "searxng_web_search",
          status: "inProgress",
        },
      });
      expect(events).toContainEqual({
        type: "tool.completed",
        name: "floral_search/searxng_web_search",
        detail: {
          server: "floral_search",
          tool: "searxng_web_search",
          status: "completed",
        },
      });
    } finally {
      await runtime.stop();
    }
  });

  it("surfaces provider usage limits as a typed error", async () => {
    const runtime = createRuntime("quota");
    try {
      await runtime.start();
      await expect(runtime.run({ text: "hello", cwd: process.cwd() })).rejects.toMatchObject({
        name: "CodexRuntimeError",
        kind: "usage_limit",
        retryable: false,
      });
    } finally {
      await runtime.stop();
    }
  });

  it("times out a stalled turn and attempts interruption", async () => {
    const runtime = createRuntime("timeout", 500);
    try {
      await runtime.start();
      await expect(runtime.run({ text: "hang", cwd: process.cwd() })).rejects.toMatchObject({
        kind: "request_timeout",
      });
    } finally {
      await runtime.stop();
    }
  });

  it("surfaces an unexpected app-server exit", async () => {
    const runtime = createRuntime("exit-turn");
    try {
      await runtime.start();
      let caught: unknown;
      try {
        await runtime.run({ text: "exit", cwd: process.cwd() });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(CodexRuntimeError);
      expect(caught).toMatchObject({ kind: "process_exit" });
      expect((caught as Error).message).toContain("fixture forced exit");
    } finally {
      await runtime.stop();
    }
  });
});
