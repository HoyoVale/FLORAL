import { createHash } from "node:crypto";

export type NativeConfigComponent = "codex" | "searxng" | "qq-sdk" | "mcp";

export interface NativeConfigArtifact {
  component: NativeConfigComponent;
  relativePath: string;
  mediaType: "application/json" | "application/toml" | "application/yaml";
  purpose: string;
  active: boolean;
  runtimePlaceholders: string[];
  content: string;
  sha256: string;
}

export interface NativeConfigBundle {
  schemaVersion: 1;
  authorityVersion: 1;
  requestedFingerprint: string;
  effectiveFingerprint: string;
  artifacts: NativeConfigArtifact[];
  bundleFingerprint: string;
}

export interface NativeArtifactInput extends Omit<NativeConfigArtifact, "content" | "sha256"> {
  content: string;
}

export function createNativeConfigArtifact(input: NativeArtifactInput): NativeConfigArtifact {
  const content = normalizeNativeConfigText(input.content);
  return {
    ...input,
    runtimePlaceholders: [...input.runtimePlaceholders].sort(),
    content,
    sha256: sha256(content),
  };
}

export function createNativeConfigBundle(input: {
  requestedFingerprint: string;
  effectiveFingerprint: string;
  artifacts: NativeConfigArtifact[];
}): NativeConfigBundle {
  const artifacts = [...input.artifacts].sort((left, right) => (
    left.relativePath.localeCompare(right.relativePath)
  ));
  const bundleFingerprint = sha256(JSON.stringify({
    schemaVersion: 1,
    authorityVersion: 1,
    requestedFingerprint: input.requestedFingerprint,
    effectiveFingerprint: input.effectiveFingerprint,
    artifacts: artifacts.map((artifact) => ({
      component: artifact.component,
      relativePath: artifact.relativePath,
      mediaType: artifact.mediaType,
      purpose: artifact.purpose,
      active: artifact.active,
      runtimePlaceholders: artifact.runtimePlaceholders,
      sha256: artifact.sha256,
    })),
  }));

  return {
    schemaVersion: 1,
    authorityVersion: 1,
    requestedFingerprint: input.requestedFingerprint,
    effectiveFingerprint: input.effectiveFingerprint,
    artifacts,
    bundleFingerprint,
  };
}

export function safeNativeBundleJson(bundle: NativeConfigBundle): Record<string, unknown> {
  return {
    schemaVersion: bundle.schemaVersion,
    authorityVersion: bundle.authorityVersion,
    requestedFingerprint: bundle.requestedFingerprint,
    effectiveFingerprint: bundle.effectiveFingerprint,
    bundleFingerprint: bundle.bundleFingerprint,
    artifacts: bundle.artifacts.map((artifact) => ({
      component: artifact.component,
      relativePath: artifact.relativePath,
      mediaType: artifact.mediaType,
      purpose: artifact.purpose,
      active: artifact.active,
      runtimePlaceholders: artifact.runtimePlaceholders,
      sha256: artifact.sha256,
      bytes: Buffer.byteLength(artifact.content, "utf8"),
    })),
  };
}

export function normalizeNativeConfigText(value: string): string {
  const normalized = value.replace(/\r\n?/gu, "\n");
  return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
