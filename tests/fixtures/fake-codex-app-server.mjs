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

function hasFloralRoutingPolicy(params) {
  const instructions = params?.developerInstructions;
  return typeof instructions === "string"
    && instructions.includes("floral_peekaboo/see")
    && instructions.includes("floral_peekaboo/click")
    && instructions.includes("floral_delivery/send_artifact")
    && instructions.includes("local filesystem path");
}

function hasFloralDeliveryTools(params) {
  const dynamicTools = params?.dynamicTools;
  if (!Array.isArray(dynamicTools)) return false;
  const namespace = dynamicTools.find((entry) =>
    entry?.type === "namespace" && entry?.name === "floral_delivery"
  );
  if (!namespace || !Array.isArray(namespace.tools)) return false;
  const names = namespace.tools.map((tool) => tool?.name).sort();
  return JSON.stringify(names) === JSON.stringify([
    "register_outbound_file",
    "send_artifact",
  ]);
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
    if (
      scenario === "delivery-dynamic-tools"
      && message.params?.capabilities?.experimentalApi !== true
    ) {
      send({
        id: message.id,
        error: {
          code: -32602,
          message: "dynamic tools require experimentalApi capability",
        },
      });
      return;
    }
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
    if (
      (scenario === "developer-instructions" || scenario === "delivery-dynamic-tools")
      && !hasFloralRoutingPolicy(message.params)
    ) {
      send({ id: message.id, error: { code: -32602, message: "missing FLORAL developer instructions" } });
      return;
    }
    if (scenario === "delivery-dynamic-tools" && !hasFloralDeliveryTools(message.params)) {
      send({ id: message.id, error: { code: -32602, message: "missing FLORAL delivery dynamic tools" } });
      return;
    }
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
    if (scenario === "resume" && !hasFloralRoutingPolicy(message.params)) {
      send({ id: message.id, error: { code: -32602, message: "resume missing FLORAL developer instructions" } });
      return;
    }
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
    if (scenario === "auto-review" && message.params?.approvalsReviewer !== "auto_review") {
      send({ id: message.id, error: { code: -32602, message: "approval reviewer must be auto_review" } });
      return;
    }
    if (scenario === "full-access-turn") {
      if (message.params?.approvalPolicy !== "untrusted") {
        send({ id: message.id, error: { code: -32602, message: "full approval policy must be untrusted" } });
        return;
      }
      if (message.params?.sandboxPolicy?.type !== "dangerFullAccess") {
        send({ id: message.id, error: { code: -32602, message: "full sandbox must be dangerFullAccess" } });
        return;
      }
      if (message.params?.approvalsReviewer !== "user") {
        send({ id: message.id, error: { code: -32602, message: "full reviewer must remain user for client interception" } });
        return;
      }
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
      if (scenario === "auto-review") {
        sendSuccess(activeThreadId, activeTurnId, "auto review configured");
        return;
      }

      if (scenario === "full-access-turn") {
        sendSuccess(activeThreadId, activeTurnId, "full access configured");
        return;
      }

      if (scenario === "permission-approval" || scenario === "permission-session-approval") {
        waitingForApproval = true;
        send({
          id: "approval_permission_1",
          method: "item/permissions/requestApproval",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            itemId: "permission_1",
            environmentId: null,
            startedAtMs: Date.now(),
            cwd: process.cwd(),
            reason: "need network and one extra read root",
            permissions: {
              network: { enabled: true },
              fileSystem: {
                read: ["/tmp/shared"],
                write: null,
              },
            },
          },
        });
        return;
      }

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

      if (scenario === "gui-shell-bypass") {
        waitingForApproval = true;
        send({
          id: "approval_1",
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            itemId: "command_gui_1",
            command: "/opt/homebrew/bin/peekaboo click --on button_42",
            cwd: process.cwd(),
            reason: "attempt GUI control through shell",
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

      if (scenario === "mcp-artifact") {
        send({
          method: "item/started",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            item: {
              id: "mcp_artifact_1",
              type: "mcpToolCall",
              server: "floral_peekaboo",
              tool: "image",
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
              id: "mcp_artifact_1",
              type: "mcpToolCall",
              server: "floral_peekaboo",
              tool: "image",
              status: "completed",
              result: {
                content: [{
                  type: "text",
                  text: "artifactId=artifact-screen-fixture\nartifactPath=/tmp/floral-screen.png\nsource=floral_peekaboo/image",
                }],
                structuredContent: null,
                _meta: null,
              },
            },
          },
        });
        sendSuccess(activeThreadId, activeTurnId, "artifact captured");
        return;
      }

      if (scenario === "delivery-register") {
        send({
          id: "dynamic_1",
          method: "item/tool/call",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            callId: "call_register_1",
            namespace: "floral_delivery",
            tool: "register_outbound_file",
            arguments: {
              local_path: "/tmp/outbound/report.txt",
              file_name: "report.txt",
            },
          },
        });
        return;
      }

      if (scenario === "delivery-send") {
        send({
          id: "dynamic_1",
          method: "item/tool/call",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            callId: "call_send_1",
            namespace: "floral_delivery",
            tool: "send_artifact",
            arguments: {
              artifact_id: "artifact-screen-fixture",
              caption: "current screen",
            },
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

  if (message.id === "dynamic_1" && "result" in message) {
    const success = message.result?.success;
    const text = message.result?.contentItems?.[0]?.text ?? "";
    if (
      scenario === "delivery-register"
      && success === true
      && text.includes("artifact_registration=registered")
      && text.includes("artifactId=artifact-file-fixture")
    ) {
      sendSuccess(activeThreadId, activeTurnId, "delivery register complete");
      return;
    }
    if (
      scenario === "delivery-send"
      && success === true
      && text.includes("artifact_delivery=sent")
      && text.includes("artifactId=artifact-screen-fixture")
    ) {
      sendSuccess(activeThreadId, activeTurnId, "delivery send complete");
      return;
    }
    send({
      method: "turn/completed",
      params: {
        threadId: activeThreadId,
        turn: {
          id: activeTurnId,
          status: "failed",
          error: { message: `unexpected dynamic tool response: ${text}` },
          items: [],
        },
      },
    });
    return;
  }

  if (
    waitingForApproval
    && message.id === "approval_permission_1"
    && "result" in message
  ) {
    waitingForApproval = false;
    const expectedScope = scenario === "permission-session-approval" ? "session" : "turn";
    const permissions = message.result?.permissions;
    const valid = message.result?.scope === expectedScope
      && permissions?.network?.enabled === true
      && Array.isArray(permissions?.fileSystem?.read)
      && permissions.fileSystem.read.length === 1
      && permissions.fileSystem.read[0] === "/tmp/shared"
      && permissions?.fileSystem?.write === null;
    if (valid) {
      sendSuccess(
        activeThreadId,
        activeTurnId,
        scenario === "permission-session-approval"
          ? "permission session approval accepted safely"
          : "permission approval accepted safely",
      );
    } else {
      const error = {
        message: `unexpected permission response: ${JSON.stringify(message.result)}`,
        codexErrorInfo: "Other",
      };
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
    if (scenario === "gui-shell-bypass") {
      if (decision === "decline") {
        sendSuccess(activeThreadId, activeTurnId, "gui shell bypass declined safely");
      } else {
        const error = { message: `unexpected GUI shell bypass decision: ${String(decision)}`, codexErrorInfo: "Other" };
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

    if (decision === "decline") {
      sendSuccess(activeThreadId, activeTurnId, "approval declined safely");
    } else if (decision === "accept") {
      sendSuccess(activeThreadId, activeTurnId, "approval accepted safely");
    } else if (decision === "acceptForSession") {
      sendSuccess(activeThreadId, activeTurnId, "approval session accepted safely");
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
