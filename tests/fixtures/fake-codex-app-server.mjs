import { isAbsolute } from "node:path";
import { createInterface } from "node:readline";

const scenario = process.argv[2] ?? "normal";
const lines = createInterface({ input: process.stdin });
let initialized = false;
let resumed = false;
let activeThreadId = "thr_new";
let activeTurnId = "turn_1";
let waitingForApproval = false;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendSuccess(threadId = activeThreadId, turnId = activeTurnId, finalText = "authoritative final") {
  send({
    method: "item/agentMessage/delta",
    params: { threadId, turnId, itemId: "item_agent", delta: "streamed text" },
  });
  send({
    method: "item/completed",
    params: {
      threadId,
      turnId,
      item: { id: "item_agent", type: "agentMessage", text: finalText, phase: "final_answer" },
    },
  });
  send({
    method: "turn/completed",
    params: { threadId, turn: { id: turnId, status: "completed", items: [] } },
  });
}

lines.on("line", (line) => {
  const message = JSON.parse(line);

  if (message.method === "initialize") {
    if (scenario === "malformed") process.stdout.write("this-is-not-json\n");
    initialized = true;
    send({ id: message.id, result: { userAgent: "fake-codex", codexHome: "/tmp/fake" } });
    return;
  }

  if (message.method === "initialized") return;

  if (!initialized) {
    send({ id: message.id, error: { code: -32002, message: "Not initialized" } });
    return;
  }

  if (message.method === "thread/start") {
    if (scenario === "on-request-file-approval") {
      const capabilityFields = ["approvalPolicy", "approvalsReviewer", "sandbox"];
      if (capabilityFields.some((key) => key in (message.params ?? {}))) {
        send({ id: message.id, error: { code: -32602, message: "thread bootstrap must stay capability-neutral" } });
        return;
      }
      if (typeof message.params?.cwd !== "string" || !isAbsolute(message.params.cwd)) {
        send({ id: message.id, error: { code: -32602, message: "thread cwd must be absolute" } });
        return;
      }
    }
    activeThreadId = "thr_new";
    send({ id: message.id, result: { thread: { id: activeThreadId } } });
    return;
  }

  if (message.method === "thread/resume") {
    if (scenario === "stale-resume") {
      send({
        id: message.id,
        error: {
          code: -32602,
          message: `thread not found: ${String(message.params?.threadId)}`,
        },
      });
      return;
    }
    if (scenario === "resume-config-error") {
      send({
        id: message.id,
        error: {
          code: -32600,
          message: "failed to load configuration: /tmp/config.toml:12:1: invalid type",
        },
      });
      return;
    }
    resumed = true;
    activeThreadId = message.params.threadId;
    send({ id: message.id, result: { thread: { id: activeThreadId } } });
    return;
  }

  if (message.method === "turn/start") {
    if (scenario === "on-request-file-approval" && message.params?.approvalPolicy !== "untrusted") {
      send({
        id: message.id,
        error: { code: -32602, message: `invalid turn approval policy: ${String(message.params?.approvalPolicy)}` },
      });
      return;
    }
    if (scenario === "on-request-file-approval" && message.params?.sandboxPolicy?.type !== "workspaceWrite") {
      send({
        id: message.id,
        error: {
          code: -32602,
          message: `invalid turn sandbox policy: ${String(message.params?.sandboxPolicy?.type)}`,
        },
      });
      return;
    }
    if (scenario === "on-request-file-approval" && message.params?.approvalsReviewer !== "user") {
      send({ id: message.id, error: { code: -32602, message: "approval reviewer must be user" } });
      return;
    }
    if (scenario === "on-request-file-approval") {
      const roots = message.params?.sandboxPolicy?.writableRoots;
      if (
        typeof message.params?.cwd !== "string"
        || !isAbsolute(message.params.cwd)
        || !Array.isArray(roots)
        || roots.length !== 1
        || roots[0] !== message.params.cwd
        || message.params?.sandboxPolicy?.networkAccess !== false
      ) {
        send({ id: message.id, error: { code: -32602, message: "workspaceWrite must be absolute cwd-only and network-disabled" } });
        return;
      }
    }
    if (scenario === "resume" && !resumed) {
      send({ id: message.id, error: { code: -32602, message: "thread was not resumed" } });
      return;
    }

    activeThreadId = message.params.threadId;
    activeTurnId = scenario === "resume" ? "turn_resumed" : "turn_1";
    send({ id: message.id, result: { turn: { id: activeTurnId, status: "inProgress" } } });

    setImmediate(() => {
      if (scenario === "quota") {
        const error = {
          message: "You've hit your usage limit.",
          codexErrorInfo: { type: "UsageLimitExceeded" },
        };
        send({ method: "error", params: { threadId: activeThreadId, turnId: activeTurnId, error } });
        send({
          method: "turn/completed",
          params: {
            threadId: activeThreadId,
            turn: { id: activeTurnId, status: "failed", error, items: [] },
          },
        });
        return;
      }

      if (scenario === "on-request-file-approval") {
        waitingForApproval = true;
        send({
          method: "item/started",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            item: {
              id: "patch_1",
              type: "fileChange",
              status: "inProgress",
              changes: [
                { path: "src/example.ts", kind: "update", diff: "+ const secret = 'not-for-approval';" },
              ],
            },
          },
        });
        send({
          id: "approval_1",
          method: "item/fileChange/requestApproval",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            itemId: "patch_1",
            reason: "update one workspace file",
          },
        });
        return;
      }

      if (scenario === "approval") {
        waitingForApproval = true;
        send({
          id: "approval_1",
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            itemId: "command_1",
            command: "echo unsafe --token supersecret",
            cwd: process.cwd(),
            reason: "fixture approval",
          },
        });
        return;
      }

      if (scenario === "mcp-approval") {
        waitingForApproval = true;
        send({
          method: "item/started",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            item: {
              id: "mcp_click_1",
              type: "mcpToolCall",
              server: "floral_peekaboo",
              tool: "click",
              status: "inProgress",
              arguments: {
                snapshot: "snapshot-1",
                on: "button_42",
                intent: "展开 VS Code 的 src 文件夹",
              },
            },
          },
        });
        send({
          id: "approval_1",
          method: "mcpServer/elicitation/request",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            serverName: "floral_peekaboo",
            mode: "form",
            _meta: {
              codex_approval_kind: "mcp_tool_call",
              tool_title: "Click",
              tool_params: {
                snapshot: "snapshot-1",
                on: "button_42",
                intent: "展开 VS Code 的 src 文件夹",
              },
            },
            message: "Allow floral_peekaboo to run tool click?",
            requestedSchema: { type: "object", properties: {} },
          },
        });
        return;
      }

      if (scenario === "mcp-tool") {
        send({
          method: "item/started",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            item: {
              id: "mcp_1",
              type: "mcpToolCall",
              server: "floral_search",
              tool: "searxng_web_search",
              status: "inProgress",
            },
          },
        });
        send({
          method: "item/completed",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            item: {
              id: "mcp_1",
              type: "mcpToolCall",
              server: "floral_search",
              tool: "searxng_web_search",
              status: "completed",
            },
          },
        });
        sendSuccess(activeThreadId, activeTurnId, "search complete");
        return;
      }

      if (scenario === "tool-after-commentary-without-final") {
        send({
          method: "item/completed",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            item: {
              id: "commentary_1",
              type: "agentMessage",
              text: "我来搜索一下大模型可视化相关的开源项目和工具：",
              phase: "commentary",
            },
          },
        });
        send({
          method: "item/started",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            item: {
              id: "mcp_1",
              type: "mcpToolCall",
              server: "floral_search",
              tool: "searxng_web_search",
              status: "inProgress",
            },
          },
        });
        send({
          method: "item/completed",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            item: {
              id: "mcp_1",
              type: "mcpToolCall",
              server: "floral_search",
              tool: "searxng_web_search",
              status: "completed",
            },
          },
        });
        send({
          method: "turn/completed",
          params: {
            threadId: activeThreadId,
            turn: {
              id: activeTurnId,
              status: "completed",
              items: [
                {
                  id: "commentary_1",
                  type: "agentMessage",
                  text: "我来搜索一下大模型可视化相关的开源项目和工具：",
                  phase: "commentary",
                },
                {
                  id: "mcp_1",
                  type: "mcpToolCall",
                  server: "floral_search",
                  tool: "searxng_web_search",
                  status: "completed",
                },
              ],
            },
          },
        });
        return;
      }

      if (scenario === "unphased-message-before-tool-without-final") {
        send({
          method: "item/agentMessage/delta",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            itemId: "message_1",
            delta: "我来搜索一下：",
          },
        });
        send({
          method: "item/completed",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            item: {
              id: "message_1",
              type: "agentMessage",
              text: "我来搜索一下：",
            },
          },
        });
        send({
          method: "item/started",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            item: {
              id: "command_1",
              type: "commandExecution",
              status: "inProgress",
            },
          },
        });
        send({
          method: "item/completed",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            item: {
              id: "command_1",
              type: "commandExecution",
              status: "completed",
            },
          },
        });
        send({
          method: "turn/completed",
          params: {
            threadId: activeThreadId,
            turn: {
              id: activeTurnId,
              status: "completed",
              items: [
                { id: "message_1", type: "agentMessage", text: "我来搜索一下：" },
                { id: "command_1", type: "commandExecution", status: "completed" },
              ],
            },
          },
        });
        return;
      }

      if (scenario === "terminal-final-after-commentary") {
        send({
          method: "item/completed",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            item: {
              id: "commentary_1",
              type: "agentMessage",
              text: "我先看一下路线图和最近的阶段文档，确认当前开发进度：",
              phase: "commentary",
            },
          },
        });
        send({
          method: "item/started",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            item: {
              id: "mcp_1",
              type: "mcpToolCall",
              server: "floral_search",
              tool: "searxng_web_search",
              status: "inProgress",
            },
          },
        });
        send({
          method: "item/completed",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            item: {
              id: "mcp_1",
              type: "mcpToolCall",
              server: "floral_search",
              tool: "searxng_web_search",
              status: "completed",
            },
          },
        });
        send({
          method: "turn/completed",
          params: {
            threadId: activeThreadId,
            turn: {
              id: activeTurnId,
              status: "completed",
              items: [
                {
                  id: "commentary_1",
                  type: "agentMessage",
                  text: "我先看一下路线图和最近的阶段文档，确认当前开发进度：",
                  phase: "commentary",
                },
                {
                  id: "final_1",
                  type: "agentMessage",
                  text: "FLORAL 当前处于 Phase 5.4 QQ Conversation UX 阶段。",
                  phase: "final_answer",
                },
              ],
            },
          },
        });
        return;
      }

      if (scenario === "timeout") return;
      if (scenario === "exit-turn") {
        process.stderr.write("fixture forced exit\n");
        process.exit(17);
      }

      sendSuccess(
        activeThreadId,
        activeTurnId,
        scenario === "resume"
          ? "resumed final"
          : scenario === "stale-resume"
            ? "recovered final"
            : "authoritative final",
      );
    });
    return;
  }

  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    send({
      method: "turn/completed",
      params: {
        threadId: message.params.threadId,
        turn: { id: message.params.turnId, status: "interrupted", items: [] },
      },
    });
    return;
  }

  if (message.method === "test/exit") {
    process.stderr.write("fixture request exit\n");
    process.exit(23);
  }

  if (waitingForApproval && message.id === "approval_1" && "result" in message) {
    waitingForApproval = false;
    if (scenario === "mcp-approval") {
      const action = message.result?.action;
      if (action === "decline") {
        sendSuccess(activeThreadId, activeTurnId, "mcp approval declined safely");
      } else if (
        action === "accept"
        && message.result?.content
        && Object.keys(message.result.content).length === 0
        && message.result?._meta === null
      ) {
        sendSuccess(activeThreadId, activeTurnId, "mcp approval accepted safely");
      } else {
        const error = { message: `unexpected MCP approval action: ${String(action)}`, codexErrorInfo: "Other" };
        send({
          method: "turn/completed",
          params: {
            threadId: activeThreadId,
            turn: { id: activeTurnId, status: "failed", error, items: [] },
          },
        });
      }
      return;
    }

    const decision = message.result?.decision;
    if (decision === "decline") {
      sendSuccess(activeThreadId, activeTurnId, "approval declined safely");
    } else if (decision === "accept") {
      sendSuccess(activeThreadId, activeTurnId, "approval accepted safely");
    } else {
      const error = { message: `unexpected approval decision: ${String(decision)}`, codexErrorInfo: "Other" };
      send({
        method: "turn/completed",
        params: {
          threadId: activeThreadId,
          turn: { id: activeTurnId, status: "failed", error, items: [] },
        },
      });
    }
    return;
  }

  if (typeof message.id === "number") {
    send({ id: message.id, error: { code: -32601, message: `unknown method ${String(message.method)}` } });
  }
});

process.on("SIGTERM", () => process.exit(0));
