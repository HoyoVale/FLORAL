import { describe, expect, it } from "vitest";
import type {
  AgentRuntime,
  ChatTransport,
} from "../src/core/contracts.js";
import type {
  AgentEvent,
  AgentRunRequest,
  AgentRunResult,
  IncomingMessage,
  OutgoingMessage,
} from "../src/core/types.js";
import { GatewayService } from "../src/service/gateway.js";
import { AuthorizationAuthority } from "../src/policy/authorization-authority.js";
import type { McpRuntimeRegistry } from "../src/config/mcp/mcp-runtime-registry.js";
import { MemoryThreadStore } from "../src/storage/memory-thread-store.js";

class TestTransport implements ChatTransport {
  readonly name = "test-transport";
  readonly sent: OutgoingMessage[] = [];
  #handler: ((message: IncomingMessage) => Promise<void>) | undefined;

  async start(handler: (message: IncomingMessage) => Promise<void>): Promise<void> {
    this.#handler = handler;
  }

  async receive(message: IncomingMessage): Promise<void> {
    if (!this.#handler) throw new Error("transport not started");
    await this.#handler(message);
  }

  async send(message: OutgoingMessage): Promise<void> {
    this.sent.push(message);
  }

  async stop(): Promise<void> {}
}

class TestAgent implements AgentRuntime {
  readonly name = "test-agent";
  readonly requests: AgentRunRequest[] = [];
  readonly interrupts: string[] = [];
  #threadCounter = 0;

  async start(): Promise<void> {}

  async run(
    request: AgentRunRequest,
    onEvent?: (event: AgentEvent) => void,
  ): Promise<AgentRunResult> {
    this.requests.push(request);
    const threadId = request.threadId ?? `thread-${++this.#threadCounter}`;
    onEvent?.({ type: "run.started", threadId });
    const finalText = `reply:${request.text}`;
    onEvent?.({ type: "run.completed", threadId, finalText });
    return { threadId, finalText };
  }

  async interrupt(threadId: string): Promise<void> {
    this.interrupts.push(threadId);
  }

  async stop(): Promise<void> {}
}



class ApprovalAgent implements AgentRuntime {
  readonly name = "approval-agent";
  readonly approvalRequested = deferred<void>();

  async start(): Promise<void> {}

  async run(
    request: AgentRunRequest,
    onEvent?: (event: AgentEvent) => void,
  ): Promise<AgentRunResult> {
    const threadId = "thread-approval";
    onEvent?.({ type: "run.started", threadId });
    const handler = request.approvalHandler;
    if (!handler) throw new Error("approval handler missing");
    this.approvalRequested.resolve(undefined);
    const decision = await handler({
      requestId: "private-agent-request-id",
      kind: "file-change",
      capability: "files.write",
      summary: "修改一个工作区文件",
      source: "codex",
    });
    const finalText = decision === "approve" ? "approved-work" : "denied-work";
    onEvent?.({ type: "run.completed", threadId, finalText });
    return { threadId, finalText };
  }

  async interrupt(): Promise<void> {}
  async stop(): Promise<void> {}
}

class FailingTransport extends TestTransport {
  override async send(_message: OutgoingMessage): Promise<void> {
    throw new Error("delivery unavailable");
  }
}

class DeferredAgent implements AgentRuntime {
  readonly name = "deferred-agent";
  readonly interrupts: string[] = [];
  readonly started = deferred<void>();
  readonly completion = deferred<AgentRunResult>();

  async start(): Promise<void> {}

  async run(
    _request: AgentRunRequest,
    onEvent?: (event: AgentEvent) => void,
  ): Promise<AgentRunResult> {
    onEvent?.({ type: "run.started", threadId: "thread-running" });
    this.started.resolve(undefined);
    return await this.completion.promise;
  }

  async interrupt(threadId: string): Promise<void> {
    this.interrupts.push(threadId);
    this.completion.reject(new Error("interrupted"));
  }

  async stop(): Promise<void> {}
}

describe("GatewayService identity and commands", () => {
  it("auto-claims the trusted mock owner and persists the active thread", async () => {
    const transport = new TestTransport();
    const agent = new TestAgent();
    const store = new MemoryThreadStore();
    const gateway = new GatewayService(transport, agent, store, {
      cwd: ".",
      trustMockOwner: true,
    });
    await gateway.start();

    const message = incoming({
      id: "m-1",
      transport: "mock",
      text: "hello",
    });
    await transport.receive(message);

    expect(agent.requests).toHaveLength(1);
    expect(transport.sent.at(-1)?.text).toBe("reply:hello");

    const resolved = await store.resolveIdentity(message.identity);
    expect(resolved?.role).toBe("owner");
    expect(
      resolved
        ? await store.getActiveThread(resolved.conversationId)
        : undefined,
    ).toBe("thread-1");

    const auditJson = JSON.stringify(store.auditEvents());
    expect(auditJson).not.toContain("hello");
    expect(auditJson).toContain("agent.run_completed");
    await gateway.stop();
  });

  it("rejects oversized inbound text before agent execution", async () => {
    const transport = new TestTransport();
    const agent = new TestAgent();
    const gateway = new GatewayService(
      transport,
      agent,
      new MemoryThreadStore(),
      { cwd: ".", trustMockOwner: true },
    );
    await gateway.start();

    await transport.receive(incoming({
      id: "large-message",
      transport: "mock",
      text: "x".repeat(32_001),
    }));

    expect(agent.requests).toHaveLength(0);
    expect(transport.sent.at(-1)?.text).toContain("消息过长");
    await gateway.stop();
  });

  it("deduplicates transport message IDs before agent execution", async () => {
    const transport = new TestTransport();
    const agent = new TestAgent();
    const gateway = new GatewayService(
      transport,
      agent,
      new MemoryThreadStore(),
      { cwd: ".", trustMockOwner: true },
    );
    await gateway.start();

    const message = incoming({
      id: "same-message",
      transport: "mock",
      text: "once",
    });
    await transport.receive(message);
    await transport.receive(message);

    expect(agent.requests).toHaveLength(1);
    expect(transport.sent).toHaveLength(1);
    await gateway.stop();
  });

  it("fails closed until the QQ owner supplies the pairing code", async () => {
    const transport = new TestTransport();
    const agent = new TestAgent();
    const store = new MemoryThreadStore();
    const gateway = new GatewayService(transport, agent, store, {
      cwd: ".",
      ownerPairingCode: "correct-horse-battery",
      trustMockOwner: false,
    });
    await gateway.start();

    await transport.receive(incoming({
      id: "q-1",
      transport: "qq",
      text: "hello",
    }));
    expect(agent.requests).toHaveLength(0);
    expect(transport.sent.at(-1)?.text).toContain("尚未绑定");

    await transport.receive(incoming({
      id: "q-2",
      transport: "qq",
      text: "/pair wrong",
    }));
    expect(transport.sent.at(-1)?.text).toBe("配对失败。");

    await transport.receive(incoming({
      id: "q-3",
      transport: "qq",
      text: "/pair correct-horse-battery",
    }));
    expect(transport.sent.at(-1)?.text).toContain("绑定成功");

    await transport.receive(incoming({
      id: "q-4",
      transport: "qq",
      text: "authorized",
    }));
    expect(agent.requests).toHaveLength(1);
    expect(transport.sent.at(-1)?.text).toBe("reply:authorized");
    await gateway.stop();
  });

  it("supports status and new-thread commands without exposing IDs", async () => {
    const transport = new TestTransport();
    const agent = new TestAgent();
    const store = new MemoryThreadStore();
    const gateway = new GatewayService(transport, agent, store, {
      cwd: ".",
      trustMockOwner: true,
      runtimeStatusLines: async () => [
        "cost_guard=ready",
        "cost_24h=¥0.100/10.00",
      ],
    });
    await gateway.start();

    const base = {
      transport: "mock" as const,
      externalUserId: "owner",
      conversationId: "conversation",
    };
    await transport.receive(incoming({ id: "c-1", text: "hello", ...base }));
    await transport.receive(incoming({ id: "c-2", text: "/status", ...base }));

    const status = transport.sent.at(-1)?.text ?? "";
    expect(status).toContain("thread=active");
    expect(status).toContain("run=idle");
    expect(status).toContain("cost_guard=ready");
    expect(status).toContain("cost_24h=¥0.100/10.00");
    expect(status).not.toContain("thread-1");

    await transport.receive(incoming({ id: "c-3", text: "/new", ...base }));
    expect(transport.sent.at(-1)?.text).toContain("新的会话上下文");

    await transport.receive(incoming({ id: "c-4", text: "/status", ...base }));
    expect(transport.sent.at(-1)?.text).toContain("thread=none");
    await gateway.stop();
  });

  it("dispatches /stop to the active agent run", async () => {
    const transport = new TestTransport();
    const agent = new DeferredAgent();
    const gateway = new GatewayService(
      transport,
      agent,
      new MemoryThreadStore(),
      { cwd: ".", trustMockOwner: true },
    );
    await gateway.start();

    const runPromise = transport.receive(incoming({
      id: "s-1",
      transport: "mock",
      text: "long task",
    }));
    await agent.started.promise;

    await transport.receive(incoming({
      id: "s-2",
      transport: "mock",
      text: "/stop",
    }));
    await runPromise;

    expect(agent.interrupts).toEqual(["thread-running"]);
    expect(transport.sent.some((entry) => entry.text.includes("停止请求"))).toBe(true);
    expect(transport.sent.some((entry) => entry.text === "当前任务已停止。")).toBe(true);
    await gateway.stop();
  });

  it("resolves an owner-scoped one-shot approval through /approve", async () => {
    const transport = new TestTransport();
    const agent = new ApprovalAgent();
    const store = new MemoryThreadStore();
    const registry: McpRuntimeRegistry = {
      schemaVersion: 1,
      authorityVersion: 1,
      profile: "test",
      registryFingerprint: "test-only",
      servers: [],
    };
    const gateway = new GatewayService(transport, agent, store, {
      cwd: ".",
      trustMockOwner: true,
      authorization: {
        authority: new AuthorizationAuthority({
          enabled: true,
          sandboxMode: "workspace-write",
          mcpRegistry: registry,
        }),
        approvalTtlMs: 5_000,
        maxPendingApprovals: 4,
        ownerOnlyRemoteApproval: true,
      },
    });
    await gateway.start();

    const runPromise = transport.receive(incoming({
      id: "a-1",
      transport: "mock",
      text: "please edit",
    }));
    await agent.approvalRequested.promise;
    await new Promise((resolve) => setImmediate(resolve));

    const prompt = transport.sent.find((entry) => entry.text.includes("FLORAL 请求一次性授权"));
    expect(prompt?.text).toContain("能力=files.write");
    expect(prompt?.text).not.toContain("private-agent-request-id");
    const approvalId = /审批编号=([A-Z0-9]+)/u.exec(prompt?.text ?? "")?.[1];
    expect(approvalId).toBeTruthy();

    await transport.receive(incoming({
      id: "a-2",
      transport: "mock",
      text: `/approve ${approvalId}`,
    }));
    await runPromise;

    expect(transport.sent.some((entry) => entry.text === "一次性授权已批准。")).toBe(true);
    expect(transport.sent.some((entry) => entry.text === "approved-work")).toBe(true);
    expect(store.auditEvents().some((event) => event.eventType === "authorization.approval_granted")).toBe(true);
    await gateway.stop();
  });

  it("audits final delivery failures without rerunning the agent", async () => {
    const transport = new FailingTransport();
    const agent = new TestAgent();
    const store = new MemoryThreadStore();
    const gateway = new GatewayService(transport, agent, store, {
      cwd: ".",
      trustMockOwner: true,
    });
    await gateway.start();

    await transport.receive(incoming({
      id: "delivery-failure",
      transport: "mock",
      text: "hello",
    }));

    expect(agent.requests).toHaveLength(1);
    expect(store.auditEvents().some((event) =>
      event.eventType === "transport.delivery_failed"
    )).toBe(true);
    await gateway.stop();
  });

});

function incoming(options: {
  id: string;
  text: string;
  transport: "qq" | "mock";
  externalUserId?: string;
  conversationId?: string;
}): IncomingMessage {
  return {
    id: options.id,
    identity: {
      transport: options.transport,
      botId: "bot-1",
      externalUserId: options.externalUserId ?? "user-1",
      conversationId: options.conversationId ?? "conversation-1",
      displayName: "Test User",
    },
    text: options.text,
    receivedAt: new Date("2026-08-06T10:00:00Z"),
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
