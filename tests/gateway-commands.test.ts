import { describe, expect, it } from "vitest";
import type {
  AgentExtensionDiscoveryRuntime,
  AgentRuntime,
  AgentSkillRuntime,
  ChatTransport,
  ConversationActivityState,
  ConversationActivityTransport,
  InteractiveApprovalPrompt,
  InteractiveApprovalTransport,
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
import {
  SYSTEM_AWARENESS_SCHEMA_VERSION,
  createDefaultSystemDefinitionRegistry,
  type SystemAwarenessReadProvider,
} from "../src/system-awareness/index.js";

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

class InteractiveTransport extends TestTransport implements InteractiveApprovalTransport {
  readonly approvals: InteractiveApprovalPrompt[] = [];

  async sendInteractiveApprovalPrompt(prompt: InteractiveApprovalPrompt): Promise<void> {
    this.approvals.push(prompt);
  }
}

class ActivityTransport extends TestTransport implements ConversationActivityTransport {
  readonly activities: Array<{
    conversationId: string;
    state: ConversationActivityState;
  }> = [];

  async setConversationActivity(
    conversationId: string,
    state: ConversationActivityState,
  ): Promise<void> {
    this.activities.push({ conversationId, state });
  }
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



class SkillAgent extends TestAgent implements AgentSkillRuntime {
  async listSkills(): Promise<import("../src/core/contracts.js").AgentSkillSummary[]> {
    return [
      {
        name: "system-status",
        description: "Collect a read-only health summary of the Mac Agent host.",
        path: "/tmp/skills/system-status/SKILL.md",
        scope: "user",
        enabled: true,
      },
      {
        name: "attachment-analysis",
        description: "Analyze user-provided FLORAL attachments safely.",
        path: "/tmp/skills/attachment-analysis/SKILL.md",
        scope: "user",
        enabled: true,
      },
    ];
  }
}

class ExtensionAgent extends TestAgent implements AgentExtensionDiscoveryRuntime {
  async listInstalledApps(): Promise<import("../src/core/contracts.js").AgentAppSummary[]> {
    return [
      { id: "github", runtimeName: "GitHub", enabled: true, callable: true, source: "installed-runtime" },
      { id: "disabled-app", runtimeName: "Disabled App", enabled: false, callable: false, source: "installed-runtime" },
    ];
  }

  async listAvailableApps(): Promise<import("../src/core/contracts.js").AgentAppSummary[]> {
    return [{
      id: "github",
      runtimeName: "GitHub",
      description: "GitHub connector directory entry",
      installUrl: "https://chatgpt.com/apps/github/github",
      enabled: true,
      accessible: true,
      source: "directory",
    }];
  }

  async readApps(): Promise<import("../src/core/contracts.js").AgentAppReadResult> {
    return {
      apps: [{
        id: "github",
        name: "GitHub",
        pluginDisplayNames: ["GitHub"],
        tools: [],
      }],
      missingAppIds: [],
    };
  }

  async listNativeExtensionFeatures(): Promise<import("../src/core/contracts.js").AgentNativeFeatureSummary[]> {
    return [
      { name: "apps", stage: "beta", enabled: true, defaultEnabled: true },
      {
        name: "plugins",
        stage: "underDevelopment",
        enabled: true,
        defaultEnabled: false,
      },
    ];
  }

  async listMcpServers(): Promise<import("../src/core/contracts.js").AgentMcpServerSummary[]> {
    return [
      {
        name: "github",
        status: "ready",
        authStatus: "authenticated",
        tools: [{ name: "search_repositories", readOnly: true }],
      },
      {
        name: "chrome-devtools",
        status: "failed",
        failureReason: "Chrome unavailable",
        tools: [],
      },
    ];
  }
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

class ToolDeferredAgent implements AgentRuntime {
  readonly name = "tool-deferred-agent";
  readonly started = deferred<void>();
  readonly completion = deferred<AgentRunResult>();

  constructor(private readonly toolName: string) {}

  async start(): Promise<void> {}

  async run(
    _request: AgentRunRequest,
    onEvent?: (event: AgentEvent) => void,
  ): Promise<AgentRunResult> {
    onEvent?.({ type: "run.started", threadId: "thread-tool-running" });
    onEvent?.({ type: "tool.started", name: this.toolName });
    this.started.resolve(undefined);
    return await this.completion.promise;
  }

  async interrupt(): Promise<void> {}
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

  it("publishes typing activity for an agent run and clears it before the final reply", async () => {
    const transport = new ActivityTransport();
    const gateway = new GatewayService(
      transport,
      new TestAgent(),
      new MemoryThreadStore(),
      { cwd: ".", trustMockOwner: true },
    );
    await gateway.start();

    await transport.receive(incoming({
      id: "activity-1",
      transport: "mock",
      text: "hello",
    }));

    expect(transport.activities).toEqual([
      { conversationId: "conversation-1", state: "typing" },
      { conversationId: "conversation-1", state: "idle" },
    ]);
    expect(transport.sent.at(-1)?.text).toBe("reply:hello");
    await gateway.stop();
  });

  it("sends one delayed visible activity fallback for a long search run", async () => {
    const transport = new TestTransport();
    const agent = new ToolDeferredAgent("floral_search/searxng_web_search");
    const store = new MemoryThreadStore();
    const gateway = new GatewayService(transport, agent, store, {
      cwd: ".",
      trustMockOwner: true,
      conversationUx: {
        visibleActivityFallback: true,
        visibleActivityDelayMs: 5,
      },
    });
    await gateway.start();

    const runPromise = transport.receive(incoming({
      id: "visible-search-1",
      transport: "mock",
      text: "search something",
    }));
    await agent.started.promise;
    await sleep(20);

    expect(transport.sent.map((entry) => entry.text)).toEqual([
      "正在搜索相关信息…",
    ]);

    agent.completion.resolve({
      threadId: "thread-tool-running",
      finalText: "search complete",
    });
    await runPromise;

    expect(transport.sent.map((entry) => entry.text)).toEqual([
      "正在搜索相关信息…",
      "search complete",
    ]);
    expect(store.auditEvents().some((event) =>
      event.eventType === "conversation.visible_activity_sent"
      && event.payload?.category === "search"
    )).toBe(true);
    await gateway.stop();
  });

  it("does not add a visible activity message when a run completes before the delay", async () => {
    const transport = new TestTransport();
    const gateway = new GatewayService(
      transport,
      new TestAgent(),
      new MemoryThreadStore(),
      {
        cwd: ".",
        trustMockOwner: true,
        conversationUx: {
          visibleActivityFallback: true,
          visibleActivityDelayMs: 50,
        },
      },
    );
    await gateway.start();

    await transport.receive(incoming({
      id: "visible-fast-1",
      transport: "mock",
      text: "hello",
    }));
    await sleep(70);

    expect(transport.sent.map((entry) => entry.text)).toEqual(["reply:hello"]);
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
        "codex_memory=enabled",
        "codex_memory_use=true",
        "codex_memory_generate=true",
        "codex_memory_scope=codex-home",
        "codex_memory_active_config=unified",
        "codex_memory_runtime_config=present",
        "codex_memory_lifecycle=armed",
        "codex_memory_storage=absent",
        "codex_memory_index=absent",
        "codex_memory_summary=absent",
        "codex_memory_raw=absent",
        "codex_memory_rollout_summaries=0",
        "codex_memory_last_artifact_at=none",
        "cost_guard=ready",
        "cost_24h=¥0.100/10.00",
      ],
      nativeMemoryDiagnosticLines: async () => [
        "codex_memory_lifecycle=generated",
        "codex_memory_phase2_database=read-only",
        "codex_memory_phase2_database_file=state_5.sqlite",
        "codex_memory_stage1_outputs=2",
        "codex_memory_stage1_selected_for_phase2=0",
        "codex_memory_stage1_jobs_done=2",
        "codex_memory_stage1_jobs_error=0",
        "codex_memory_phase2_job=present",
        "codex_memory_phase2_status=error",
        "codex_memory_phase2_retry_remaining=2",
        "codex_memory_phase2_error_class=sandbox",
        "codex_memory_phase2_workspace_diff=present",
        "codex_memory_phase2_git_baseline=present",
        "codex_memory_summary=absent",
        "codex_memory_phase2_diagnosis=blocked:sandbox",
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
    expect(status).toContain("FLORAL 正常运行");
    expect(status).toContain("状态：空闲");
    expect(status).toContain("会话：已建立");
    expect(status).toContain("成本守卫：正常");
    expect(status).toContain("今日成本：¥0.100 / ¥10.00");
    expect(status).not.toContain("thread-1");
    expect(status).not.toContain("transport=");

    await transport.receive(incoming({ id: "c-3", text: "/status --debug", ...base }));
    const debugStatus = transport.sent.at(-1)?.text ?? "";
    expect(debugStatus).toContain("thread=active");
    expect(debugStatus).toContain("run=idle");
    expect(debugStatus).toContain("cost_guard=ready");
    expect(debugStatus).toContain("cost_24h=¥0.100/10.00");

    await transport.receive(incoming({ id: "c-memory", text: "/memory", ...base }));
    const memoryStatus = transport.sent.at(-1)?.text ?? "";
    expect(memoryStatus).toContain("Codex Native Memory");
    expect(memoryStatus).toContain("state=enabled");
    expect(memoryStatus).toContain("lifecycle=armed");
    expect(memoryStatus).toContain("scope=codex-home");
    expect(memoryStatus).toContain("runtime_config=present");
    expect(memoryStatus).toContain("rollout_summaries=0");
    expect(agent.requests).toHaveLength(1);

    await transport.receive(incoming({ id: "c-diagnose", text: "/memory diagnose", ...base }));
    const memoryDiagnostics = transport.sent.at(-1)?.text ?? "";
    expect(memoryDiagnostics).toContain("Codex Native Memory Phase 2 Diagnostics");
    expect(memoryDiagnostics).toContain("phase2_status=error");
    expect(memoryDiagnostics).toContain("phase2_error_class=sandbox");
    expect(memoryDiagnostics).toContain("diagnosis=blocked:sandbox");
    expect(memoryDiagnostics).not.toContain("last_error");
    expect(agent.requests).toHaveLength(1);

    await transport.receive(incoming({ id: "c-4", text: "/new", ...base }));
    expect(transport.sent.at(-1)?.text).toContain("新会话已建立");

    await transport.receive(incoming({ id: "c-5", text: "/status", ...base }));
    expect(transport.sent.at(-1)?.text).toContain("会话：未建立");
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

  it("pauses typing while an approval is pending and resumes after the decision", async () => {
    const transport = new ActivityTransport();
    const agent = new ApprovalAgent();
    const registry: McpRuntimeRegistry = {
      schemaVersion: 1,
      authorityVersion: 1,
      profile: "test",
      registryFingerprint: "test-only",
      servers: [],
    };
    const gateway = new GatewayService(
      transport,
      agent,
      new MemoryThreadStore(),
      {
        cwd: ".",
        trustMockOwner: true,
        authorization: {
          authority: new AuthorizationAuthority({
            enabled: true,
            sandboxMode: "workspace-write",
            allowRemoteFileChangeApproval: false,
            mcpRegistry: registry,
          }),
          approvalTtlMs: 5_000,
          maxPendingApprovals: 4,
          ownerOnlyRemoteApproval: true,
        },
      },
    );
    await gateway.start();

    const runPromise = transport.receive(incoming({
      id: "activity-approval-1",
      transport: "mock",
      text: "please edit",
    }));
    await agent.approvalRequested.promise;
    await new Promise((resolve) => setImmediate(resolve));

    expect(transport.activities).toEqual([
      { conversationId: "conversation-1", state: "typing" },
      { conversationId: "conversation-1", state: "idle" },
    ]);

    const prompt = transport.sent.find((entry) =>
      entry.text.includes("FLORAL 请求一次性授权")
    );
    const approvalId = /审批编号=([A-Z0-9]+)/u.exec(prompt?.text ?? "")?.[1];
    expect(approvalId).toBeTruthy();

    await transport.receive(incoming({
      id: "activity-approval-2",
      transport: "mock",
      text: `/approve ${approvalId}`,
    }));
    await runPromise;

    expect(transport.activities).toEqual([
      { conversationId: "conversation-1", state: "typing" },
      { conversationId: "conversation-1", state: "idle" },
      { conversationId: "conversation-1", state: "typing" },
      { conversationId: "conversation-1", state: "idle" },
    ]);
    await gateway.stop();
  });

  it("presents a remote one-shot approval through the optional interactive transport", async () => {
    const transport = new InteractiveTransport();
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
          allowRemoteFileChangeApproval: false,
          mcpRegistry: registry,
        }),
        approvalTtlMs: 5_000,
        maxPendingApprovals: 4,
        ownerOnlyRemoteApproval: true,
      },
    });
    await gateway.start();

    const runPromise = transport.receive(incoming({
      id: "interactive-a-1",
      transport: "mock",
      text: "please edit",
    }));
    await agent.approvalRequested.promise;
    await new Promise((resolve) => setImmediate(resolve));

    expect(transport.approvals).toHaveLength(1);
    expect(transport.sent.some((entry) =>
      entry.text.includes("FLORAL 请求一次性授权")
    )).toBe(false);
    const approval = transport.approvals[0]!;
    expect(approval).toMatchObject({
      conversationId: "conversation-1",
      capability: "files.write",
      summary: "修改一个工作区文件",
    });

    await transport.receive(incoming({
      id: "interactive-a-2",
      transport: "mock",
      text: `/approve ${approval.approvalId}`,
    }));
    await runPromise;

    expect(transport.sent.some((entry) => entry.text === "一次性授权已批准。")).toBe(true);
    expect(transport.sent.some((entry) => entry.text === "approved-work")).toBe(true);
    expect(store.auditEvents().some((event) =>
      event.eventType === "authorization.approval_requested"
      && event.payload?.presentation === "interactive"
    )).toBe(true);
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
          allowRemoteFileChangeApproval: false,
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

  it("lists Codex skills through /skills without starting an agent turn", async () => {
    const transport = new TestTransport();
    const agent = new SkillAgent();
    const gateway = new GatewayService(
      transport,
      agent,
      new MemoryThreadStore(),
      { cwd: ".", trustMockOwner: true },
    );
    await gateway.start();

    await transport.receive(incoming({
      id: "skills-1",
      transport: "mock",
      text: "/skills",
    }));

    const reply = transport.sent.at(-1)?.text ?? "";
    expect(reply).toContain("Codex Skills");
    expect(reply).toContain("$system-status");
    expect(reply).toContain("$attachment-analysis");
    expect(agent.requests).toHaveLength(0);
    await gateway.stop();
  });

  it("lists installed Codex Apps through /apps without starting an agent turn", async () => {
    const transport = new TestTransport();
    const agent = new ExtensionAgent();
    const gateway = new GatewayService(
      transport,
      agent,
      new MemoryThreadStore(),
      { cwd: ".", trustMockOwner: true },
    );
    await gateway.start();

    await transport.receive(incoming({
      id: "apps-1",
      transport: "mock",
      text: "/apps",
    }));

    const reply = transport.sent.at(-1)?.text ?? "";
    expect(reply).toContain("Codex Apps");
    expect(reply).toContain("GitHub");
    expect(reply).toContain("callable=true");
    expect(reply).toContain("目录可见：1；可访问：1");
    expect(reply).toContain("install=supported-handoff");
    expect(agent.requests).toHaveLength(0);
    await gateway.stop();
  });

  it("reports native Plugin feature maturity through /plugins without calling a Plugin catalog", async () => {
    const transport = new TestTransport();
    const agent = new ExtensionAgent();
    const gateway = new GatewayService(
      transport,
      agent,
      new MemoryThreadStore(),
      { cwd: ".", trustMockOwner: true },
    );
    await gateway.start();

    await transport.receive(incoming({
      id: "plugins-1",
      transport: "mock",
      text: "/plugins",
    }));

    const reply = transport.sent.at(-1)?.text ?? "";
    expect(reply).toContain("Codex Native Extensions");
    expect(reply).toContain("plugins: stage=underDevelopment enabled=true");
    expect(reply).toContain("plugin/list");
    expect(agent.requests).toHaveLength(0);
    await gateway.stop();
  });

  it("lists native MCP runtime status through /mcp without starting an agent turn", async () => {
    const transport = new TestTransport();
    const agent = new ExtensionAgent();
    const gateway = new GatewayService(
      transport,
      agent,
      new MemoryThreadStore(),
      { cwd: ".", trustMockOwner: true },
    );
    await gateway.start();

    await transport.receive(incoming({
      id: "mcp-1",
      transport: "mock",
      text: "/mcp",
    }));

    const reply = transport.sent.at(-1)?.text ?? "";
    expect(reply).toContain("Codex MCP");
    expect(reply).toContain("github");
    expect(reply).toContain("status=ready");
    expect(reply).toContain("chrome-devtools");
    expect(agent.requests).toHaveLength(0);
    await gateway.stop();
  });

  it("reads the bounded system map through /system without starting an agent turn", async () => {
    const transport = new TestTransport();
    const agent = new TestAgent();
    const registry = createDefaultSystemDefinitionRegistry();
    let reads = 0;
    const systemAwareness: SystemAwarenessReadProvider = {
      read: async (context) => {
        reads += 1;
        expect(context?.cwd).toBe(".");
        expect(context?.execution?.gateway).toEqual({
          controlMode: "ask",
          sandboxMode: "workspace-write",
          approvalPolicy: "untrusted",
          approvalsReviewer: "user",
          approvalRoute: "owner",
        });
        expect(context?.execution?.turn).toBeUndefined();
        return {
          definitions: registry.list(),
          snapshot: {
            schemaVersion: SYSTEM_AWARENESS_SCHEMA_VERSION,
            generatedAt: "2026-08-10T00:00:00.000Z",
            definitionFingerprint: registry.fingerprint(),
            components: [{
              componentId: "floral.service",
              observed: true,
              facts: [],
            }],
            observers: [{
              observerId: "fixture",
              status: "ok",
              observedAt: "2026-08-10T00:00:00.000Z",
              evidenceCount: 0,
            }],
          },
        };
      },
    };
    const gateway = new GatewayService(
      transport,
      agent,
      new MemoryThreadStore(),
      { cwd: ".", trustMockOwner: true, systemAwareness },
    );
    await gateway.start();

    await transport.receive(incoming({
      id: "system-1",
      transport: "mock",
      text: "/system",
    }));
    expect(transport.sent.at(-1)?.text).toContain("FLORAL System Awareness");

    await transport.receive(incoming({
      id: "system-2",
      transport: "mock",
      text: "/system floral.service",
    }));
    expect(transport.sent.at(-1)?.text).toContain("component=floral.service");
    expect(transport.sent.at(-1)?.text).toContain("owner_party=floral");
    expect(reads).toBe(2);
    expect(agent.requests).toHaveLength(0);
    await gateway.stop();
  });

  it("provides compact QQ-style help without running the agent", async () => {
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
      id: "help-1",
      transport: "mock",
      text: "/help",
    }));

    const help = transport.sent.at(-1)?.text ?? "";
    expect(help).toContain("直接发送消息即可开始对话");
    expect(help).toContain("/status   查看运行状态");
    expect(help).toContain("/skills   查看当前 Codex Skill");
    expect(help).toContain("/apps     查看当前 Codex App");
    expect(help).toContain("/plugins  查看 Codex Plugin 功能状态");
    expect(help).toContain("/mcp      查看当前 Codex MCP server");
    expect(help).toContain("/system   查看 FLORAL 只读系统地图");
    expect(help).not.toContain("/approve");
    expect(agent.requests).toHaveLength(0);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
