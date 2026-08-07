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
  AgentEvent,
  AgentRunRequest,
  AgentRunResult,
  AuditEventInput,
  ExternalIdentity,
  IncomingMessage,
  OutgoingMediaMessage,
  OutgoingMessage,
  ResolvedGatewayIdentity,
  TransportKind,
} from "../src/core/types.js";
import { ArtifactEgressPolicy } from "../src/policy/artifact-egress-policy.js";
import { GatewayService } from "../src/service/gateway.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

class ArtifactTransport implements ChatTransport, MediaTransport {
  readonly name = "artifact-test";
  readonly sent: OutgoingMessage[] = [];
  readonly media: OutgoingMediaMessage[] = [];
  #onMessage: ((message: IncomingMessage) => Promise<void>) | undefined;

  async start(onMessage: (message: IncomingMessage) => Promise<void>): Promise<void> {
    this.#onMessage = onMessage;
  }

  async send(message: OutgoingMessage): Promise<void> {
    this.sent.push(message);
  }

  async sendMedia(message: OutgoingMediaMessage): Promise<void> {
    this.media.push(message);
  }

  async stop(): Promise<void> {}

  async receive(message: IncomingMessage): Promise<void> {
    if (!this.#onMessage) throw new Error("transport not started");
    await this.#onMessage(message);
  }
}

class ArtifactAgent implements AgentRuntime {
  readonly name = "artifact-agent";

  constructor(private readonly artifactPath: string) {}

  async start(): Promise<void> {}

  async run(
    request: AgentRunRequest,
    onEvent?: (event: AgentEvent) => void,
  ): Promise<AgentRunResult> {
    const threadId = request.threadId ?? "thread-artifact";
    onEvent?.({ type: "run.started", threadId });
    onEvent?.({
      type: "artifact.available",
      artifact: {
        id: "screen-1",
        kind: "image",
        localPath: this.artifactPath,
        source: {
          type: "mcp",
          serverId: "floral_peekaboo",
          toolName: "image",
        },
        caption: "**screen captured**",
      },
    });
    const finalText = "截图处理完成。";
    onEvent?.({ type: "run.completed", threadId, finalText });
    return { threadId, finalText };
  }

  async interrupt(): Promise<void> {}
  async stop(): Promise<void> {}
}

class ArtifactStore implements GatewayStore {
  readonly audits: AuditEventInput[] = [];
  thread: string | undefined;

  constructor(private readonly resolved: ResolvedGatewayIdentity) {}

  async resolveIdentity(): Promise<ResolvedGatewayIdentity | undefined> {
    return this.resolved;
  }
  async claimOwner(): Promise<ResolvedGatewayIdentity> {
    return this.resolved;
  }
  async hasOwner(_transport: TransportKind, _botId: string): Promise<boolean> {
    return true;
  }
  async acceptMessage(
    _identity: ExternalIdentity,
    _messageId: string,
    _receivedAt: Date,
  ): Promise<boolean> {
    return true;
  }
  async getActiveThread(): Promise<string | undefined> {
    return this.thread;
  }
  async setActiveThread(_conversationId: string, threadId: string): Promise<void> {
    this.thread = threadId;
  }
  async clearActiveThread(): Promise<void> {
    this.thread = undefined;
  }
  async appendAudit(event: AuditEventInput): Promise<void> {
    this.audits.push(event);
  }
  async close(): Promise<void> {}
}

function inbound(): IncomingMessage {
  return {
    id: "msg-artifact",
    identity: {
      transport: "feishu",
      botId: "cli_floral",
      externalUserId: "ou_owner",
      conversationId: "oc_delivery",
    },
    text: "send screenshot",
    receivedAt: new Date(1_786_123_456_789),
  };
}

describe("Gateway artifact egress", () => {
  it("delivers an allowlisted AgentArtifact through MediaTransport before the final reply", async () => {
    const dir = await mkdtemp(join(tmpdir(), "floral-gateway-artifact-"));
    temporary.push(dir);
    const root = join(dir, "outbound");
    const screenshot = join(root, "screen.png");
    const policy = new ArtifactEgressPolicy({
      enabled: true,
      allowedRoots: [root],
      allowedMcpProducers: ["floral_peekaboo/image"],
      allowedFloralCapabilities: [],
      maxArtifactsPerRun: 4,
      maxBytesPerRun: 25_000_000,
    });
    await policy.initialize();
    await writeFile(screenshot, "image");

    const transport = new ArtifactTransport();
    const store = new ArtifactStore({
      userId: "user-owner",
      role: "owner",
      conversationId: "conversation-internal",
    });
    const gateway = new GatewayService(
      transport,
      new ArtifactAgent(screenshot),
      store,
      {
        cwd: dir,
        artifactEgress: { policy },
      },
    );

    await gateway.start();
    await transport.receive(inbound());

    expect(transport.media).toHaveLength(1);
    expect(transport.media[0]).toMatchObject({
      conversationId: "oc_delivery",
      kind: "image",
      caption: "**screen captured**",
    });
    expect(transport.sent.at(-1)?.text).toBe("截图处理完成。");
    expect(store.audits).toContainEqual(expect.objectContaining({
      eventType: "artifact.egress_sent",
      payload: expect.objectContaining({
        artifactId: "screen-1",
        kind: "image",
        sourceCapability: "screen.capture",
        bytes: 5,
      }),
    }));

    await gateway.stop();
  });

  it("does not exfiltrate an artifact outside the local allowlisted root", async () => {
    const dir = await mkdtemp(join(tmpdir(), "floral-gateway-artifact-deny-"));
    temporary.push(dir);
    const root = join(dir, "outbound");
    const outside = join(dir, "outside.png");
    const policy = new ArtifactEgressPolicy({
      enabled: true,
      allowedRoots: [root],
      allowedMcpProducers: ["floral_peekaboo/image"],
      allowedFloralCapabilities: [],
      maxArtifactsPerRun: 4,
      maxBytesPerRun: 25_000_000,
    });
    await policy.initialize();
    await writeFile(outside, "secret");

    const transport = new ArtifactTransport();
    const store = new ArtifactStore({
      userId: "user-owner",
      role: "owner",
      conversationId: "conversation-internal",
    });
    const gateway = new GatewayService(
      transport,
      new ArtifactAgent(outside),
      store,
      {
        cwd: dir,
        artifactEgress: { policy },
      },
    );

    await gateway.start();
    await transport.receive(inbound());

    expect(transport.media).toHaveLength(0);
    expect(transport.sent.at(-1)?.text).toBe("截图处理完成。");
    expect(store.audits).toContainEqual(expect.objectContaining({
      eventType: "artifact.egress_denied",
      payload: expect.objectContaining({
        artifactId: "screen-1",
        reason: "path-outside-allowed-root",
      }),
    }));

    await gateway.stop();
  });
});
