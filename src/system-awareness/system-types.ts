import type { Capability } from "../core/types.js";

export const SYSTEM_AWARENESS_SCHEMA_VERSION = 1 as const;

export type SystemComponentKind =
  | "service"
  | "configuration"
  | "policy"
  | "runtime"
  | "provider"
  | "transport"
  | "storage"
  | "workspace"
  | "skill"
  | "mcp"
  | "app"
  | "plugin"
  | "extension"
  | "host";

export type SystemAuthorityParty =
  | "floral"
  | "codex"
  | "macos"
  | "provider"
  | "project"
  | "user"
  | "third-party";

export interface SystemAuthorityRef {
  party: SystemAuthorityParty;
  name: string;
  responsibility: string;
}

export type SystemFailureDomain =
  | "floral"
  | "codex"
  | "host"
  | "network"
  | "provider"
  | "transport"
  | "storage"
  | "project"
  | "third-party"
  | "mixed";

export type SystemEvidenceSourceKind =
  | "runtime-rpc"
  | "configuration"
  | "environment"
  | "registry"
  | "filesystem"
  | "process"
  | "probe"
  | "runtime-context"
  | "derived";

export type SystemEvidenceConfidence =
  | "authoritative"
  | "observed"
  | "inferred"
  | "unknown";

export type SystemEvidenceScope =
  | "process"
  | "machine"
  | "runtime"
  | "project"
  | "conversation"
  | "external";

export interface SystemStateSourceDefinition {
  id: string;
  kind: SystemEvidenceSourceKind;
  authority: "authoritative" | "observational" | "supporting";
  facts: readonly string[];
  description: string;
  availability?: "always" | "contextual" | undefined;
}

export type SystemManagementDisposition =
  | "automatic"
  | "approval-gated"
  | "user-mediated"
  | "host-only"
  | "source-change"
  | "unsupported";

export type SystemApprovalRequirement =
  | "automatic"
  | "chat-confirmation"
  | "local-confirmation"
  | "autonomy-policy"
  | "user-mediated"
  | "source-change"
  | "not-applicable";

export interface ManagementActionDefinition {
  id: string;
  description: string;
  disposition: SystemManagementDisposition;
  approval: SystemApprovalRequirement;
  capability?: Capability | undefined;
  executor?: string | undefined;
  verification?: string | undefined;
  notes?: string | undefined;
}

export interface SystemDefinition {
  schemaVersion: typeof SYSTEM_AWARENESS_SCHEMA_VERSION;
  id: string;
  displayName: string;
  description: string;
  kind: SystemComponentKind;
  owner: SystemAuthorityRef;
  authority: SystemAuthorityRef;
  stateSources: readonly SystemStateSourceDefinition[];
  managementActions: readonly ManagementActionDefinition[];
  secretDependencies: readonly string[];
  failureDomain: SystemFailureDomain;
  parentId?: string | undefined;
  tags: readonly string[];
}

export type SystemEvidenceValue =
  | null
  | boolean
  | number
  | string
  | readonly SystemEvidenceValue[]
  | { readonly [key: string]: SystemEvidenceValue };

export interface SystemEvidenceSource {
  id: string;
  kind: SystemEvidenceSourceKind;
}

export interface SystemEvidence {
  componentId: string;
  fact: string;
  source: SystemEvidenceSource;
  observedAt: string;
  confidence: SystemEvidenceConfidence;
  scope: SystemEvidenceScope;
  value: SystemEvidenceValue;
  reason?: string | undefined;
}

export type SystemFactResolution = "resolved" | "unknown" | "conflict";

export interface SystemFactSnapshot {
  fact: string;
  resolution: SystemFactResolution;
  confidence: SystemEvidenceConfidence;
  value: SystemEvidenceValue;
  evidence: readonly SystemEvidence[];
}

export interface SystemComponentSnapshot {
  componentId: string;
  observed: boolean;
  facts: readonly SystemFactSnapshot[];
}

export interface SystemObserverSnapshot {
  observerId: string;
  status: "ok" | "failed";
  observedAt: string;
  evidenceCount: number;
  errorType?: string | undefined;
}

export interface SystemSnapshot {
  schemaVersion: typeof SYSTEM_AWARENESS_SCHEMA_VERSION;
  generatedAt: string;
  definitionFingerprint: string;
  components: readonly SystemComponentSnapshot[];
  observers: readonly SystemObserverSnapshot[];
}

export interface SystemGatewayExecutionContext {
  controlMode: "ask" | "auto" | "full";
  sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy: "never" | "on-request" | "untrusted";
  approvalsReviewer: "user" | "auto_review";
  approvalRoute?: "owner" | "auto-review" | "full-auto-codex-native" | undefined;
}

export interface SystemTurnExecutionContext {
  selector: "sandbox-policy" | "permission-profile";
  sandboxMode: "read-only" | "workspace-write" | "danger-full-access" | "not-applicable";
  permissionProfile: string | "none";
  approvalPolicy: "never" | "on-request" | "untrusted";
  approvalsReviewer: "user" | "auto_review";
}

export interface SystemExecutionObservationContext {
  gateway?: SystemGatewayExecutionContext | undefined;
  turn?: SystemTurnExecutionContext | undefined;
}

export interface SystemObservationContext {
  cwd?: string | undefined;
  threadId?: string | undefined;
  execution?: SystemExecutionObservationContext | undefined;
}

export interface SystemObserver {
  readonly id: string;
  readonly componentIds: readonly string[];
  observe(context: SystemObservationContext): Promise<readonly SystemEvidence[]>;
}
