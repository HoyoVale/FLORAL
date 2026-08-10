import type {
  AgentArtifactDeliveryHandler,
  AgentArtifactRegistrationHandler,
} from "../core/types.js";

export interface FloralArtifactToolCall {
  tool: string;
  arguments: Record<string, unknown>;
  registrationHandler?: AgentArtifactRegistrationHandler | undefined;
  deliveryHandler?: AgentArtifactDeliveryHandler | undefined;
}

export interface FloralArtifactToolResult {
  success: boolean;
  text: string;
}

export class FloralArtifactToolController {
  async handle(call: FloralArtifactToolCall): Promise<FloralArtifactToolResult> {
    if (call.tool === "register_outbound_file") {
      const parsed = parseRegisterOutboundFileArguments(call.arguments);
      if (!parsed || !call.registrationHandler) {
        return denied("artifact_registration", "handler-or-arguments");
      }
      const result = await call.registrationHandler(parsed).catch(() => ({
        status: "denied" as const,
        reason: "registration-handler-error",
      }));
      return result.status === "registered"
        ? {
            success: true,
            text: `artifact_registration=registered\nartifactId=${result.artifactId}`,
          }
        : denied("artifact_registration", safeToken(result.reason));
    }

    if (call.tool === "send_artifact") {
      const parsed = parseSendArtifactArguments(call.arguments);
      if (!parsed || !call.deliveryHandler) {
        return denied("artifact_delivery", "handler-or-arguments");
      }
      const result = await call.deliveryHandler(parsed).catch(() => ({
        status: "failed" as const,
        artifactId: parsed.artifactId,
        reason: "delivery-handler-error",
      }));
      return result.status === "sent"
        ? {
            success: true,
            text: [
              "artifact_delivery=sent",
              `artifactId=${result.artifactId}`,
              `kind=${result.kind}`,
              `bytes=${String(result.byteLength)}`,
            ].join("\n"),
          }
        : {
            success: false,
            text: [
              `artifact_delivery=${result.status}`,
              `artifactId=${result.artifactId}`,
              `reason=${safeToken(result.reason)}`,
            ].join("\n"),
          };
    }

    return denied("artifact_delivery", "unsupported-tool");
  }
}

function denied(scope: string, reason: string): FloralArtifactToolResult {
  return {
    success: false,
    text: `${scope}=denied\nreason=${reason}`,
  };
}

function parseRegisterOutboundFileArguments(
  value: Record<string, unknown>,
): Parameters<AgentArtifactRegistrationHandler>[0] | undefined {
  const keys = Object.keys(value).sort();
  if (keys.some((key) => !["caption", "file_name", "local_path"].includes(key))) {
    return undefined;
  }
  const localPath = readString(value.local_path);
  if (!localPath || localPath.length > 4096 || /[\r\n\0]/u.test(localPath)) {
    return undefined;
  }
  const fileName = readOptionalText(value.file_name, 180);
  const caption = readOptionalText(value.caption, 240);
  if (value.file_name !== undefined && !fileName) return undefined;
  if (value.caption !== undefined && !caption) return undefined;
  if (fileName && (fileName.includes("/") || fileName.includes("\\"))) return undefined;
  return {
    localPath,
    ...(fileName ? { fileName } : {}),
    ...(caption ? { caption } : {}),
  };
}

function parseSendArtifactArguments(
  value: Record<string, unknown>,
): Parameters<AgentArtifactDeliveryHandler>[0] | undefined {
  const keys = Object.keys(value).sort();
  if (keys.some((key) => !["artifact_id", "caption"].includes(key))) {
    return undefined;
  }
  const artifactId = readString(value.artifact_id);
  if (!artifactId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/u.test(artifactId)) {
    return undefined;
  }
  const caption = readOptionalText(value.caption, 240);
  if (value.caption !== undefined && !caption) return undefined;
  return {
    artifactId,
    ...(caption ? { caption } : {}),
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readOptionalText(value: unknown, maxLength: number): string | undefined {
  if (value === undefined || typeof value !== "string") return undefined;
  const normalized = value
    .replace(/[\u0000-\u001F\u007F]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized || Array.from(normalized).length > maxLength) return undefined;
  return normalized;
}

function safeToken(value: string): string {
  const normalized = value
    .replace(/[^A-Za-z0-9._:-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return normalized.slice(0, 96) || "unknown";
}
