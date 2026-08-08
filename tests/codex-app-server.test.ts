import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CodexAppServerRuntime } from "../src/agent/codex-app-server.js";
import { CodexRuntimeError } from "../src/agent/codex-errors.js";
import type { AgentEvent } from "../src/core/types.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url));

function createRuntime(
  scenario: string,
  timeoutMs = 5_000,
  options: {
    approvalPolicy?: "never" | "on-request" | "untrusted";
    sandboxMode?: "read-only" | "workspace-write";
    approvalsReviewer?: "user";
  } = {},
): CodexAppServerRuntime {
  return new CodexAppServerRuntime({
    command: process.execPath,
    args: [fixture, scenario],
    requestTimeoutMs: timeoutMs,
    defaultModel: undefined,
    ...options,
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

  it("injects the FLORAL routing policy as developer instructions", async () => {
    const runtime = createRuntime("developer-instructions");
    try {
      await runtime.start();
      const result = await runtime.run({ text: "hello", cwd: process.cwd() });
      expect(result.finalText).toBe("authoritative final");
    } finally {
      await runtime.stop();
    }
  });

  it("exposes FLORAL generic artifact delivery as client-hosted dynamic tools", async () => {
    const runtime = createRuntime("delivery-dynamic-tools");
    try {
      await runtime.start();
      const result = await runtime.run({ text: "hello", cwd: process.cwd() });
      expect(result.finalText).toBe("authoritative final");
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

  it("does not reset a thread when -32600 is a configuration failure", async () => {
    const runtime = createRuntime("resume-config-error");
    try {
      await runtime.start();
      await expect(runtime.run({
        threadId: "thr_existing",
        text: "continue",
        cwd: process.cwd(),
      })).rejects.toMatchObject({
        name: "CodexRuntimeError",
        method: "thread/resume",
        code: -32600,
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

  it("forwards a bounded approval request to the run-scoped handler", async () => {
    const runtime = createRuntime("approval");
    const events: AgentEvent[] = [];
    try {
      await runtime.start();
      const result = await runtime.run(
        {
          text: "run command",
          cwd: process.cwd(),
          approvalHandler: async (request) => {
            expect(request).toMatchObject({
              kind: "command-execution",
              capability: "shell.execute",
              source: "codex",
            });
            expect(request.summary).toContain("echo unsafe");
            expect(request.summary).toContain("--token <redacted>");
            expect(request.summary).not.toContain("supersecret");
            return "approve";
          },
        },
        (event) => events.push(event),
      );

      expect(result.finalText).toBe("approval accepted safely");
      expect(events).toContainEqual(expect.objectContaining({
        type: "approval.requested",
        capability: "shell.execute",
        kind: "command-execution",
      }));
    } finally {
      await runtime.stop();
    }
  });



  it("declines shell GUI automation bypasses without delegating them for approval", async () => {
    const runtime = createRuntime("gui-shell-bypass");
    let approvalCalls = 0;
    const events: AgentEvent[] = [];
    try {
      await runtime.start();
      const result = await runtime.run(
        {
          text: "click through shell",
          cwd: process.cwd(),
          approvalHandler: async () => {
            approvalCalls += 1;
            return "approve";
          },
        },
        (event) => events.push(event),
      );
      expect(result.finalText).toBe("gui shell bypass declined safely");
      expect(approvalCalls).toBe(0);
      expect(events.some((event) => event.type === "approval.requested")).toBe(false);
    } finally {
      await runtime.stop();
    }
  });

  it("keeps thread bootstrap minimal and applies approval/sandbox at turn scope", async () => {
    const runtime = createRuntime("on-request-file-approval", 5_000, {
      approvalPolicy: "untrusted",
      sandboxMode: "workspace-write",
      approvalsReviewer: "user",
    });
    try {
      await runtime.start();
      const result = await runtime.run({
        text: "edit one file",
        cwd: ".",
        approvalHandler: async (request) => {
          expect(request).toMatchObject({
            kind: "file-change",
            capability: "files.write",
            source: "codex",
          });
          expect(request.summary).toContain("update:src/example.ts");
          expect(request.summary).not.toContain("not-for-approval");
          return "approve";
        },
      });
      expect(result.finalText).toBe("approval accepted safely");
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

  it("registers a trusted Peekaboo artifact from the completed MCP result", async () => {
    const runtime = createRuntime("mcp-artifact");
    const events: AgentEvent[] = [];
    try {
      await runtime.start();
      const result = await runtime.run(
        { text: "capture", cwd: process.cwd() },
        (event) => events.push(event),
      );
      expect(result.finalText).toBe("artifact captured");
      expect(events).toContainEqual({
        type: "artifact.registered",
        artifact: {
          id: "artifact-screen-fixture",
          kind: "image",
          localPath: "/tmp/floral-screen.png",
          source: {
            type: "mcp",
            serverId: "floral_peekaboo",
            toolName: "image",
          },
        },
      });
    } finally {
      await runtime.stop();
    }
  });

  it("delegates register_outbound_file to the run-scoped artifact handler", async () => {
    const runtime = createRuntime("delivery-register");
    try {
      await runtime.start();
      const result = await runtime.run({
        text: "register report",
        cwd: process.cwd(),
        artifactRegistrationHandler: async (request) => {
          expect(request).toEqual({
            localPath: "/tmp/outbound/report.txt",
            fileName: "report.txt",
          });
          return {
            status: "registered",
            artifactId: "artifact-file-fixture",
          };
        },
      });
      expect(result.finalText).toBe("delivery register complete");
    } finally {
      await runtime.stop();
    }
  });

  it("delegates send_artifact and returns transport-confirmed success to the model", async () => {
    const runtime = createRuntime("delivery-send");
    try {
      await runtime.start();
      const result = await runtime.run({
        text: "send screenshot",
        cwd: process.cwd(),
        artifactDeliveryHandler: async (request) => {
          expect(request).toEqual({
            artifactId: "artifact-screen-fixture",
            caption: "current screen",
          });
          return {
            status: "sent",
            artifactId: request.artifactId,
            kind: "image",
            byteLength: 123,
          };
        },
      });
      expect(result.finalText).toBe("delivery send complete");
    } finally {
      await runtime.stop();
    }
  });

  it("delegates a trusted MCP click approval to the FLORAL approval handler", async () => {
    const runtime = createRuntime("mcp-approval");
    const events: AgentEvent[] = [];
    try {
      await runtime.start();
      const result = await runtime.run(
        {
          text: "expand src",
          cwd: process.cwd(),
          approvalHandler: async (request) => {
            expect(request).toMatchObject({
              kind: "mcp-tool",
              capability: "application.control",
              source: "mcp",
              mcpServerId: "floral_peekaboo",
              mcpToolName: "click",
            });
            expect(request.summary).toContain("展开 VS Code 的 src 文件夹");
            return "approve";
          },
        },
        (event) => events.push(event),
      );
      expect(result.finalText).toBe("mcp approval accepted safely");
      expect(events).toContainEqual(expect.objectContaining({
        type: "approval.requested",
        capability: "application.control",
        kind: "mcp-tool",
      }));
    } finally {
      await runtime.stop();
    }
  });

  it("declines an MCP click when no FLORAL approval handler is available", async () => {
    const runtime = createRuntime("mcp-approval");
    try {
      await runtime.start();
      const result = await runtime.run({ text: "expand src", cwd: process.cwd() });
      expect(result.finalText).toBe("mcp approval declined safely");
    } finally {
      await runtime.stop();
    }
  });

  it("prefers the terminal final answer over an earlier commentary message", async () => {
    const runtime = createRuntime("terminal-final-after-commentary");
    try {
      await runtime.start();
      const result = await runtime.run({
        text: "inspect then summarize",
        cwd: process.cwd(),
      });

      expect(result.finalText).toBe(
        "FLORAL 当前处于 Phase 5.4 QQ Conversation UX 阶段。",
      );
    } finally {
      await runtime.stop();
    }
  });

  it("does not return a pre-tool commentary message when the turn has no final answer", async () => {
    const runtime = createRuntime("tool-after-commentary-without-final");
    try {
      await runtime.start();
      await expect(runtime.run({
        text: "search then summarize",
        cwd: process.cwd(),
      })).rejects.toMatchObject({
        name: "CodexRuntimeError",
        kind: "protocol",
      });
    } finally {
      await runtime.stop();
    }
  });

  it("invalidates an unphased pre-tool fallback after later work starts", async () => {
    const runtime = createRuntime("unphased-message-before-tool-without-final");
    try {
      await runtime.start();
      await expect(runtime.run({
        text: "inspect then answer",
        cwd: process.cwd(),
      })).rejects.toMatchObject({
        name: "CodexRuntimeError",
        kind: "protocol",
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
