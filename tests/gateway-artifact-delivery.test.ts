import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AgentRuntime,
  ChatTransport,
  GatewayStore,
  MediaTransport,
} from "../src/core/contracts.js";
import type {
  AgentArtifactDeliveryResult,
  AgentRunRequest,
  AgentRunResult,
  AuditEventInput,
  IncomingMessage,
  OutgoingMediaMessage,
  OutgoingMessage,
  ResolvedGatewayIdentity,
} from "../src/core/types.js";
import { ArtifactEgressPolicy } from "../src/policy/artifact-egress-policy.js";
import { GatewayService } from "../src/service/gateway.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

class TestTransport implements ChatTransport, MediaTransport {
  readonly name = "test-media";
  readonly text: OutgoingMessage[] = [];
  readonly media: OutgoingMediaMessage[] = [];
  #onMessage: ((message: IncomingMessage) => Promise<void>) | undefined;

  async start(onMessage: (message: IncomingMessage) => Promise<void>): Promise<void> {
    this.#onMessage = onMessage;
  }

  async send(message: OutgoingMessage): Promise<void> {
    this.text.push(message);
  }

  async sendMedia(message: OutgoingMediaMessage): Promise<void> {
    this.media.push(message);
  }

  async stop(): Promise<void> {}

  async emit(text: string, id = "message-1"): Promise<void> {
    if (!this.#onMessage) throw new Error("transport not started");
    await this.#onMessage({
      id,
      identity: {
        transport: "mock",
        botId: "bot",
        externalUserId: "owner-external",
        conversationId: "conversation-1",
      },
      text,
      receivedAt: new Date(),
    });
  }
}

class TestStore implements GatewayStore {
  threadId: string | undefined;
  readonly audit: AuditEventInput[] = [];

  async resolveIdentity(): Promise<ResolvedGatewayIdentity> {
    return {
      userId: "owner-1",
      role: "owner",
      conversationId: "conversation-1",
    };
  }

  async claimOwner(): Promise<ResolvedGatewayIdentity> {
    return await this.resolveIdentity();
  }

  async hasOwner(): Promise<boolean> {
    return true;
  }

  async acceptMessage(): Promise<boolean> {
    return true;
  }

  async getActiveThread(): Promise<string | undefined> {
    return this.threadId;
  }

  async setActiveThread(_conversationId: string, threadId: string): Promise<void> {
    this.threadId = threadId;
  }

  async clearActiveThread(): Promise<void> {
    this.threadId = undefined;
  }

  async appendAudit(event: AuditEventInput): Promise<void> {
    this.audit.push(event);
  }

  async close(): Promise<void> {}
}

class TestRuntime implements AgentRuntime {
  readonly name = "artifact-test-runtime";
  deliveryResult: AgentArtifactDeliveryResult | undefined;

  constructor(
    private readonly execute: (
      request: AgentRunRequest,
      onEvent: Parameters<AgentRuntime["run"]>[1],
    ) => Promise<void>,
  ) {}

  async start(): Promise<void> {}

  async run(
    request: AgentRunRequest,
    onEvent?: Parameters<AgentRuntime["run"]>[1],
  ): Promise<AgentRunResult> {
    onEvent?.({ type: "run.started", threadId: "thread-1" });
    await this.execute(request, onEvent);
    return { threadId: "thread-1", finalText: "done" };
  }

  async interrupt(): Promise<void> {}
  async stop(): Promise<void> {}
}

async function createPolicy(root: string): Promise<ArtifactEgressPolicy> {
  const policy = new ArtifactEgressPolicy({
    enabled: true,
    allowedRoots: [root],
    allowedMcpProducers: [
      "floral_peekaboo/image",
      "floral_peekaboo/see",
    ],
    allowedFloralCapabilities: ["files.read"],
    maxArtifactsPerRun: 4,
    maxBytesPerRun: 1_000_000,
  });
  await policy.initialize();
  return policy;
}

describe("Gateway generic artifact delivery", () => {
  it("registers a produced artifact without automatically sending it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "floral-artifact-catalog-"));
    temporary.push(dir);
    const root = join(dir, "outbound");
    const screenshot = join(root, "screen.png");
    const policy = await createPolicy(root);
    await writeFile(screenshot, "png");

    const transport = new TestTransport();
    const store = new TestStore();
    const runtime = new TestRuntime(async (_request, onEvent) => {
      onEvent?.({
        type: "artifact.registered",
        artifact: {
          id: "artifact-screen-1",
          kind: "image",
          localPath: screenshot,
          source: {
            type: "mcp",
            serverId: "floral_peekaboo",
            toolName: "image",
          },
        },
      });
    });
    const gateway = new GatewayService(transport, runtime, store, {
      cwd: dir,
      artifactEgress: { policy },
    });

    try {
      await gateway.start();
      await transport.emit("look at the screen");
      expect(transport.media).toHaveLength(0);
      expect(store.audit.some((event) =>
        event.eventType === "artifact.registered"
      )).toBe(true);
    } finally {
      await gateway.stop();
    }
  });

  it("sends a registered screenshot only after the explicit delivery handler is called", async () => {
    const dir = await mkdtemp(join(tmpdir(), "floral-artifact-send-"));
    temporary.push(dir);
    const root = join(dir, "outbound");
    const screenshot = join(root, "screen.png");
    const policy = await createPolicy(root);
    await writeFile(screenshot, "png");

    const transport = new TestTransport();
    const store = new TestStore();
    const runtime = new TestRuntime(async (request, onEvent) => {
      onEvent?.({
        type: "artifact.registered",
        artifact: {
          id: "artifact-screen-2",
          kind: "image",
          localPath: screenshot,
          source: {
            type: "mcp",
            serverId: "floral_peekaboo",
            toolName: "image",
          },
        },
      });
      if (!request.artifactDeliveryHandler) {
        throw new Error("artifact delivery handler missing");
      }
      runtime.deliveryResult = await request.artifactDeliveryHandler({
        artifactId: "artifact-screen-2",
        caption: "current screen",
      });
    });
    const gateway = new GatewayService(transport, runtime, store, {
      cwd: dir,
      artifactEgress: { policy },
    });

    try {
      await gateway.start();
      await transport.emit("send the screenshot");
      expect(runtime.deliveryResult).toMatchObject({
        status: "sent",
        artifactId: "artifact-screen-2",
        kind: "image",
      });
      expect(transport.media).toHaveLength(1);
      expect(transport.media[0]).toMatchObject({
        conversationId: "conversation-1",
        kind: "image",
        caption: "current screen",
      });
    } finally {
      await gateway.stop();
    }
  });

  it("registers and sends a terminal-staged outbound file through the same DLP boundary", async () => {
    const dir = await mkdtemp(join(tmpdir(), "floral-artifact-file-"));
    temporary.push(dir);
    const root = join(dir, "outbound");
    const file = join(root, "report.txt");
    const policy = await createPolicy(root);
    await writeFile(file, "report");

    const transport = new TestTransport();
    const store = new TestStore();
    const runtime = new TestRuntime(async (request) => {
      if (!request.artifactRegistrationHandler || !request.artifactDeliveryHandler) {
        throw new Error("artifact handlers missing");
      }
      const registration = await request.artifactRegistrationHandler({
        localPath: file,
        fileName: "report.txt",
      });
      if (registration.status !== "registered") {
        throw new Error(`registration failed: ${registration.reason}`);
      }
      runtime.deliveryResult = await request.artifactDeliveryHandler({
        artifactId: registration.artifactId,
      });
    });
    const gateway = new GatewayService(transport, runtime, store, {
      cwd: dir,
      artifactEgress: { policy },
    });

    try {
      await gateway.start();
      await transport.emit("send the staged report");
      expect(runtime.deliveryResult).toMatchObject({
        status: "sent",
        kind: "file",
      });
      expect(transport.media).toHaveLength(1);
      expect(transport.media[0]).toMatchObject({
        conversationId: "conversation-1",
        kind: "file",
        fileName: "report.txt",
      });
    } finally {
      await gateway.stop();
    }
  });
});
