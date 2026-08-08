import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentRuntime, ChatTransport } from "../src/core/contracts.js";
import type {
  AgentArtifactRegistrationResult,
  AgentRunRequest,
  AgentRunResult,
  IncomingMessage,
  OutgoingMessage,
} from "../src/core/types.js";
import { ArtifactEgressPolicy } from "../src/policy/artifact-egress-policy.js";
import { GatewayService } from "../src/service/gateway.js";
import { MemoryThreadStore } from "../src/storage/memory-thread-store.js";
import { ProjectWorkspaceRoot } from "../src/workspace/project-workspace.js";

class TestTransport implements ChatTransport {
  readonly name = "test";
  readonly sent: OutgoingMessage[] = [];
  #handler: ((message: IncomingMessage) => Promise<void>) | undefined;
  #counter = 0;

  async start(handler: (message: IncomingMessage) => Promise<void>): Promise<void> {
    this.#handler = handler;
  }
  async send(message: OutgoingMessage): Promise<void> {
    this.sent.push(message);
  }
  async stop(): Promise<void> {}
  async emit(text: string): Promise<void> {
    if (!this.#handler) throw new Error("transport not started");
    this.#counter += 1;
    await this.#handler({
      id: `m-${this.#counter}`,
      identity: {
        transport: "mock",
        botId: "bot",
        externalUserId: "owner",
        conversationId: "chat",
      },
      text,
      receivedAt: new Date(),
    });
  }
}

class ArtifactProbeAgent implements AgentRuntime {
  readonly name = "artifact-probe";
  results: AgentArtifactRegistrationResult[] = [];

  constructor(
    private readonly validPath: string,
    private readonly outsidePath: string,
  ) {}

  async start(): Promise<void> {}
  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const handler = request.artifactRegistrationHandler;
    if (!handler) throw new Error("artifact handler missing");
    this.results = [
      await handler({ localPath: this.validPath }),
      await handler({ localPath: this.outsidePath }),
    ];
    return { threadId: "thread-artifact", finalText: "done" };
  }
  async interrupt(): Promise<void> {}
  async stop(): Promise<void> {}
}

describe("workspace artifact staging", () => {
  it("allows current-project outbound staging but denies another path under the broad workspace root", async () => {
    const root = await mkdtemp(join(tmpdir(), "floral-workspace-artifact-"));
    const floralDir = join(root, "FLORAL");
    const wisteriaDir = join(root, "WISTERIA");
    const outboundDir = join(floralDir, "artifacts", "outbound");
    await mkdir(outboundDir, { recursive: true });
    await mkdir(wisteriaDir);
    const validPath = join(outboundDir, "report.txt");
    const outsidePath = join(wisteriaDir, "private.txt");
    await writeFile(validPath, "report", "utf8");
    await writeFile(outsidePath, "private", "utf8");

    const workspace = new ProjectWorkspaceRoot(root);
    await workspace.initialize();
    const policy = new ArtifactEgressPolicy({
      enabled: true,
      allowedRoots: [workspace.root],
      allowedMcpProducers: [],
      allowedFloralCapabilities: ["files.read"],
      maxArtifactsPerRun: 4,
      maxBytesPerRun: 1_000_000,
    });
    await policy.initialize();

    const floral = await realpath(floralDir);
    const agent = new ArtifactProbeAgent(validPath, outsidePath);
    const transport = new TestTransport();
    const gateway = new GatewayService(
      transport,
      agent,
      new MemoryThreadStore(),
      {
        cwd: floral,
        workspace,
        trustMockOwner: true,
        artifactEgress: { policy },
      },
    );

    try {
      await gateway.start();
      await transport.emit("create artifact report");
      expect(agent.results).toHaveLength(2);
      expect(agent.results[0]).toMatchObject({ status: "registered" });
      expect(agent.results[1]).toEqual({
        status: "denied",
        reason: "outside-run-outbound-root",
      });
    } finally {
      await gateway.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});
