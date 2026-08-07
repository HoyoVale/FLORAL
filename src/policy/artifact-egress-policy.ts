import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  AgentArtifact,
  Capability,
  GatewayRole,
  OutgoingMediaMessage,
} from "../core/types.js";
import { capabilityForMcpTool } from "./authorization-authority.js";
import { roleAllows } from "./permissions.js";

export type ArtifactEgressDenyReason =
  | "policy-disabled"
  | "invalid-artifact-id"
  | "message-send-role-denied"
  | "source-capability-denied"
  | "producer-not-allowlisted"
  | "invalid-provenance"
  | "kind-capability-mismatch"
  | "path-not-absolute"
  | "path-unavailable"
  | "path-not-regular-file"
  | "path-symlink-denied"
  | "path-hardlink-denied"
  | "path-outside-allowed-root"
  | "duplicate-artifact"
  | "run-artifact-limit"
  | "run-byte-limit";

export interface ArtifactEgressRunBudget {
  artifactCount: number;
  byteCount: number;
  artifactIds: Set<string>;
}

export type ArtifactEgressDecision =
  | {
      status: "allow";
      media: Omit<OutgoingMediaMessage, "conversationId">;
      byteLength: number;
      sourceCapability: Capability;
    }
  | {
      status: "deny";
      reason: ArtifactEgressDenyReason;
    };

export interface ArtifactEgressPolicyOptions {
  enabled: boolean;
  allowedRoots: string[];
  allowedMcpProducers: string[];
  allowedFloralCapabilities: Capability[];
  maxArtifactsPerRun: number;
  maxBytesPerRun: number;
}

/**
 * Local outbound-DLP boundary for Agent-produced artifacts.
 *
 * Capturing/creating an artifact is intentionally separate from sending it to a
 * remote chat service. This policy never trusts an Agent-provided local path by
 * itself: the path must resolve to a regular, single-link file under a local
 * developer allowlisted root, the producer must be allowlisted, and the bound
 * chat role must have both the source capability and message.send.
 */
export class ArtifactEgressPolicy {
  readonly #allowedMcpProducers: ReadonlySet<string>;
  readonly #allowedFloralCapabilities: ReadonlySet<Capability>;
  #canonicalRoots: string[] = [];
  #initialized = false;

  constructor(private readonly options: ArtifactEgressPolicyOptions) {
    validateOptions(options);
    this.#allowedMcpProducers = new Set(options.allowedMcpProducers);
    this.#allowedFloralCapabilities = new Set(options.allowedFloralCapabilities);
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    if (!this.options.enabled) {
      this.#initialized = true;
      return;
    }

    const roots: string[] = [];
    for (const configured of this.options.allowedRoots) {
      const absolute = resolve(configured);
      await mkdir(absolute, { recursive: true, mode: 0o700 });
      roots.push(await realpath(absolute));
    }
    this.#canonicalRoots = [...new Set(roots)];
    this.#initialized = true;
  }

  createRunBudget(): ArtifactEgressRunBudget {
    return {
      artifactCount: 0,
      byteCount: 0,
      artifactIds: new Set<string>(),
    };
  }

  async authorizeAndReserve(input: {
    role: GatewayRole;
    artifact: AgentArtifact;
    budget: ArtifactEgressRunBudget;
  }): Promise<ArtifactEgressDecision> {
    if (!this.#initialized) {
      throw new Error("Artifact egress policy must be initialized before use");
    }
    if (!this.options.enabled) return deny("policy-disabled");

    const artifactId = input.artifact.id.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/u.test(artifactId)) {
      return deny("invalid-artifact-id");
    }
    if (input.budget.artifactIds.has(artifactId)) {
      return deny("duplicate-artifact");
    }

    if (!roleAllows(input.role, "message.send")) {
      return deny("message-send-role-denied");
    }

    const source = resolveSourceCapability(
      input.artifact,
      this.#allowedMcpProducers,
      this.#allowedFloralCapabilities,
    );
    if (source.status === "deny") return source;
    if (!roleAllows(input.role, source.capability)) {
      return deny("source-capability-denied");
    }
    if (!kindMatchesCapability(input.artifact.kind, source.capability)) {
      return deny("kind-capability-mismatch");
    }

    const requestedPath = input.artifact.localPath.trim();
    if (!requestedPath || !isAbsolute(requestedPath)) {
      return deny("path-not-absolute");
    }

    let stat: Awaited<ReturnType<typeof lstat>>;
    let canonicalPath: string;
    try {
      stat = await lstat(requestedPath);
      if (stat.isSymbolicLink()) return deny("path-symlink-denied");
      if (!stat.isFile()) return deny("path-not-regular-file");
      if (stat.nlink > 1) return deny("path-hardlink-denied");
      canonicalPath = await realpath(requestedPath);
    } catch {
      return deny("path-unavailable");
    }

    if (!this.#canonicalRoots.some((root) => isInside(root, canonicalPath))) {
      return deny("path-outside-allowed-root");
    }

    if (input.budget.artifactCount + 1 > this.options.maxArtifactsPerRun) {
      return deny("run-artifact-limit");
    }
    if (input.budget.byteCount + stat.size > this.options.maxBytesPerRun) {
      return deny("run-byte-limit");
    }

    input.budget.artifactIds.add(artifactId);
    input.budget.artifactCount += 1;
    input.budget.byteCount += stat.size;

    return {
      status: "allow",
      sourceCapability: source.capability,
      byteLength: stat.size,
      media: {
        kind: input.artifact.kind,
        localPath: canonicalPath,
        ...(input.artifact.fileName
          ? { fileName: input.artifact.fileName }
          : {}),
        ...(input.artifact.caption
          ? { caption: input.artifact.caption }
          : {}),
      },
    };
  }
}

function resolveSourceCapability(
  artifact: AgentArtifact,
  allowedMcpProducers: ReadonlySet<string>,
  allowedFloralCapabilities: ReadonlySet<Capability>,
):
  | { status: "allow"; capability: Capability }
  | { status: "deny"; reason: ArtifactEgressDenyReason } {
  if (artifact.source.type === "floral") {
    if (!allowedFloralCapabilities.has(artifact.source.capability)) {
      return deny("producer-not-allowlisted");
    }
    return {
      status: "allow",
      capability: artifact.source.capability,
    };
  }

  const serverId = artifact.source.serverId.trim();
  const toolName = artifact.source.toolName.trim();
  if (!serverId || !toolName) return deny("invalid-provenance");

  const producer = `${serverId}/${toolName}`;
  if (!allowedMcpProducers.has(producer)) {
    return deny("producer-not-allowlisted");
  }
  const capability = capabilityForMcpTool(serverId, toolName);
  if (!capability) return deny("invalid-provenance");
  return { status: "allow", capability };
}

function kindMatchesCapability(
  kind: AgentArtifact["kind"],
  capability: Capability,
): boolean {
  if (kind === "image") return capability === "screen.capture";
  return capability === "screen.capture" || capability === "files.read";
}

function isInside(root: string, candidate: string): boolean {
  if (candidate === root) return false;
  const rel = relative(root, candidate);
  return rel.length > 0
    && rel !== ".."
    && !rel.startsWith(`..${sep}`)
    && !isAbsolute(rel);
}

function deny(
  reason: ArtifactEgressDenyReason,
): Extract<ArtifactEgressDecision, { status: "deny" }> {
  return { status: "deny", reason };
}

function validateOptions(options: ArtifactEgressPolicyOptions): void {
  if (options.enabled && options.allowedRoots.length === 0) {
    throw new Error("Artifact egress requires at least one allowed root");
  }
  if (options.allowedRoots.some((value) => !value.trim())) {
    throw new Error("Artifact egress allowed roots must not contain empty paths");
  }
  if (options.allowedMcpProducers.some((value) =>
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value)
  )) {
    throw new Error("Artifact egress MCP producers must use server/tool identifiers");
  }
  if (
    !Number.isInteger(options.maxArtifactsPerRun)
    || options.maxArtifactsPerRun < 1
    || options.maxArtifactsPerRun > 32
  ) {
    throw new Error("Artifact egress maxArtifactsPerRun must be between 1 and 32");
  }
  if (
    !Number.isInteger(options.maxBytesPerRun)
    || options.maxBytesPerRun < 1
    || options.maxBytesPerRun > 100_000_000
  ) {
    throw new Error("Artifact egress maxBytesPerRun must be between 1 and 100000000");
  }
}
