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
    if (message.params?.sandbox !== "read-only") {
      send({
        id: message.id,
        error: {
          code: -32602,
          message: `invalid thread sandbox: ${String(message.params?.sandbox)}`,
        },
      });
      return;
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
    resumed = true;
    activeThreadId = message.params.threadId;
    send({ id: message.id, result: { thread: { id: activeThreadId } } });
    return;
  }

  if (message.method === "turn/start") {
    if (message.params?.sandboxPolicy?.type !== "readOnly") {
      send({
        id: message.id,
        error: {
          code: -32602,
          message: `invalid turn sandbox policy: ${String(message.params?.sandboxPolicy?.type)}`,
        },
      });
      return;
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
