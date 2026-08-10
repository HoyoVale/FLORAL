import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  supportsMediaTransport,
  type ChatTransport,
  type GatewayStore,
} from "../core/contracts.js";
import type {
  AgentArtifact,
  AgentArtifactDeliveryResult,
  AgentArtifactRegistrationResult,
  ResolvedGatewayIdentity,
} from "../core/types.js";
import type {
  ArtifactEgressPolicy,
  ArtifactEgressRunBudget,
} from "../policy/artifact-egress-policy.js";

interface ArtifactCatalogEntry {
  artifact: AgentArtifact;
  registeredAtMs: number;
}

const ARTIFACT_CATALOG_TTL_MS = 30 * 60 * 1_000;
const ARTIFACT_CATALOG_MAX_ITEMS = 32;

export class ArtifactEgressController {
  readonly #catalogs = new Map<string, Map<string, ArtifactCatalogEntry>>();

  constructor(
    private readonly transport: ChatTransport,
    private readonly store: GatewayStore,
    private readonly policy?: ArtifactEgressPolicy | undefined,
  ) {}

  clear(): void {
    this.#catalogs.clear();
  }

  clearConversation(conversationId: string): void {
    this.#catalogs.delete(conversationId);
  }

  async registerOutboundFile(
    resolved: ResolvedGatewayIdentity,
    runCwd: string,
    request: {
      localPath: string;
      fileName?: string | undefined;
      caption?: string | undefined;
    },
  ): Promise<AgentArtifactRegistrationResult> {
    if (!await isWithinRunOutboundRoot(runCwd, request.localPath)) {
      await this.store.appendAudit({
        userId: resolved.userId,
        conversationId: resolved.conversationId,
        eventType: "artifact.registration_denied",
        payload: { kind: "file", reason: "outside-run-outbound-root" },
      }).catch(() => undefined);
      return { status: "denied", reason: "outside-run-outbound-root" };
    }
    return await this.register(resolved, {
      id: `artifact-file-${randomUUID()}`,
      kind: "file",
      localPath: request.localPath,
      source: { type: "floral", capability: "files.read" },
      ...(request.fileName ? { fileName: request.fileName } : {}),
      ...(request.caption ? { caption: request.caption } : {}),
    });
  }

  async register(
    resolved: ResolvedGatewayIdentity,
    artifact: AgentArtifact,
  ): Promise<AgentArtifactRegistrationResult> {
    if (!this.policy) return { status: "denied", reason: "policy-disabled" };
    const candidate = await this.policy.validateCandidate(artifact);
    if (candidate.status === "deny") {
      await this.store.appendAudit({
        userId: resolved.userId,
        conversationId: resolved.conversationId,
        eventType: "artifact.registration_denied",
        payload: {
          artifactId: artifact.id,
          kind: artifact.kind,
          reason: candidate.reason,
        },
      }).catch(() => undefined);
      return { status: "denied", reason: candidate.reason };
    }

    const catalog = this.#artifactCatalog(resolved.conversationId);
    this.#pruneArtifactCatalog(catalog);
    const existing = catalog.get(candidate.artifact.id);
    if (existing) {
      const same = existing.artifact.localPath === candidate.artifact.localPath
        && existing.artifact.kind === candidate.artifact.kind;
      return same
        ? { status: "registered", artifactId: candidate.artifact.id }
        : { status: "denied", reason: "duplicate-artifact-id" };
    }
    while (catalog.size >= ARTIFACT_CATALOG_MAX_ITEMS) {
      const oldest = catalog.keys().next().value as string | undefined;
      if (!oldest) break;
      catalog.delete(oldest);
    }
    catalog.set(candidate.artifact.id, {
      artifact: candidate.artifact,
      registeredAtMs: Date.now(),
    });
    await this.store.appendAudit({
      userId: resolved.userId,
      conversationId: resolved.conversationId,
      eventType: "artifact.registered",
      payload: {
        artifactId: candidate.artifact.id,
        kind: candidate.artifact.kind,
        sourceCapability: candidate.sourceCapability,
        bytes: candidate.byteLength,
      },
    }).catch(() => undefined);
    process.stderr.write(
      `artifact.registered=${safeLogToken(candidate.artifact.id)} kind=${safeLogToken(candidate.artifact.kind)}\n`,
    );
    return { status: "registered", artifactId: candidate.artifact.id };
  }

  async deliverRegistered(
    deliveryConversationId: string,
    resolved: ResolvedGatewayIdentity,
    budget: ArtifactEgressRunBudget | undefined,
    artifactId: string,
    caption?: string,
  ): Promise<AgentArtifactDeliveryResult> {
    const catalog = this.#artifactCatalog(resolved.conversationId);
    this.#pruneArtifactCatalog(catalog);
    const entry = catalog.get(artifactId);
    if (!entry) {
      await this.store.appendAudit({
        userId: resolved.userId,
        conversationId: resolved.conversationId,
        eventType: "artifact.delivery_denied",
        payload: { artifactId, reason: "artifact-not-found" },
      }).catch(() => undefined);
      return { status: "denied", artifactId, reason: "artifact-not-found" };
    }
    return await this.deliver(
      deliveryConversationId,
      resolved,
      budget,
      caption ? { ...entry.artifact, caption } : entry.artifact,
    );
  }

  async deliver(
    deliveryConversationId: string,
    resolved: ResolvedGatewayIdentity,
    budget: ArtifactEgressRunBudget | undefined,
    artifact: AgentArtifact,
  ): Promise<AgentArtifactDeliveryResult> {
    if (!this.policy || !budget) {
      await this.#auditDenied(resolved, artifact, "policy-disabled");
      return { status: "denied", artifactId: artifact.id, reason: "policy-disabled" };
    }
    const mediaTransport = supportsMediaTransport(this.transport)
      ? this.transport
      : undefined;
    if (!mediaTransport) {
      await this.#auditDenied(resolved, artifact, "transport-media-unsupported");
      return {
        status: "denied",
        artifactId: artifact.id,
        reason: "transport-media-unsupported",
      };
    }
    const decision = await this.policy.authorizeAndReserve({
      role: resolved.role,
      artifact,
      budget,
    });
    if (decision.status === "deny") {
      await this.#auditDenied(resolved, artifact, decision.reason);
      return { status: "denied", artifactId: artifact.id, reason: decision.reason };
    }
    try {
      await mediaTransport.sendMedia({
        conversationId: deliveryConversationId,
        ...decision.media,
      });
      await this.store.appendAudit({
        userId: resolved.userId,
        conversationId: resolved.conversationId,
        eventType: "artifact.egress_sent",
        payload: {
          artifactId: artifact.id,
          kind: artifact.kind,
          sourceCapability: decision.sourceCapability,
          bytes: decision.byteLength,
        },
      });
      return {
        status: "sent",
        artifactId: artifact.id,
        kind: artifact.kind,
        byteLength: decision.byteLength,
      };
    } catch (error) {
      await this.store.appendAudit({
        userId: resolved.userId,
        conversationId: resolved.conversationId,
        eventType: "artifact.egress_failed",
        payload: {
          artifactId: artifact.id,
          kind: artifact.kind,
          errorType: error instanceof Error ? error.name : "unknown",
        },
      }).catch(() => undefined);
      process.stderr.write(
        `artifact.egress_failed=${safeLogToken(error instanceof Error ? error.name : "Error")}\n`,
      );
      return {
        status: "failed",
        artifactId: artifact.id,
        reason: "transport-delivery-failed",
      };
    }
  }

  #artifactCatalog(conversationId: string): Map<string, ArtifactCatalogEntry> {
    const existing = this.#catalogs.get(conversationId);
    if (existing) return existing;
    const created = new Map<string, ArtifactCatalogEntry>();
    this.#catalogs.set(conversationId, created);
    return created;
  }

  #pruneArtifactCatalog(
    catalog: Map<string, ArtifactCatalogEntry>,
    now = Date.now(),
  ): void {
    for (const [artifactId, entry] of catalog) {
      if (now - entry.registeredAtMs > ARTIFACT_CATALOG_TTL_MS) {
        catalog.delete(artifactId);
      }
    }
  }

  async #auditDenied(
    resolved: ResolvedGatewayIdentity,
    artifact: AgentArtifact,
    reason: string,
  ): Promise<void> {
    await this.store.appendAudit({
      userId: resolved.userId,
      conversationId: resolved.conversationId,
      eventType: "artifact.egress_denied",
      payload: {
        artifactId: artifact.id,
        kind: artifact.kind,
        outcome: "denied",
        reason,
      },
    }).catch(() => undefined);
    process.stderr.write(
      `artifact.egress_denied=${safeLogToken(reason)} kind=${safeLogToken(artifact.kind)}\n`,
    );
  }
}

async function isWithinRunOutboundRoot(
  runCwd: string,
  localPath: string,
): Promise<boolean> {
  if (!isAbsolute(localPath)) return false;
  try {
    const outboundRoot = await realpath(resolve(runCwd, "artifacts", "outbound"));
    const candidate = await realpath(localPath);
    const rel = relative(outboundRoot, candidate);
    return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
  } catch {
    return false;
  }
}

function safeLogToken(value: string): string {
  return value.replace(/[^A-Za-z0-9_.\/-]/g, "_").slice(0, 96) || "unknown";
}
