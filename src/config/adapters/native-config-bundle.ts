import type { ResolvedConfigurationAuthority } from "../federation/config-authority.js";
import { renderCodexNativeArtifacts } from "./codex-native-config.js";
import { renderMcpNativeArtifact } from "./mcp-native-config.js";
import {
  createNativeConfigBundle,
  safeNativeBundleJson,
  type NativeConfigBundle,
} from "./native-config-types.js";
import { renderQqSdkNativeArtifact } from "./qq-sdk-native-config.js";
import { renderSearxngNativeArtifacts } from "./searxng-native-config.js";

export function renderNativeConfigBundle(
  authority: ResolvedConfigurationAuthority,
): NativeConfigBundle {
  const config = authority.effective;
  return createNativeConfigBundle({
    requestedFingerprint: authority.requestedFingerprint,
    effectiveFingerprint: authority.effectiveFingerprint,
    artifacts: [
      ...renderCodexNativeArtifacts(config),
      ...renderSearxngNativeArtifacts(config),
      renderQqSdkNativeArtifact(config),
      renderMcpNativeArtifact(config),
    ],
  });
}

export function renderNativeConfigSummary(bundle: NativeConfigBundle): string {
  const lines = [
    `config.native.schema_version=${String(bundle.schemaVersion)}`,
    `config.native.authority_version=${String(bundle.authorityVersion)}`,
    `config.native.requested_fingerprint=${bundle.requestedFingerprint}`,
    `config.native.effective_fingerprint=${bundle.effectiveFingerprint}`,
    `config.native.bundle_fingerprint=${bundle.bundleFingerprint}`,
    `config.native.artifacts=${String(bundle.artifacts.length)}`,
  ];
  for (const artifact of bundle.artifacts) {
    lines.push(`config.native.artifact=${artifact.relativePath}:${artifact.sha256}:${artifact.active ? "active" : "preview"}`);
  }
  lines.push("config.native=ok");
  return `${lines.join("\n")}\n`;
}

export { safeNativeBundleJson };
