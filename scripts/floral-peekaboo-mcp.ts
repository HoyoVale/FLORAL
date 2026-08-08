import { randomUUID } from "node:crypto";
import { chmod, mkdir, stat } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import {
  FLORAL_PEEKABOO_GATEWAY_NAME,
  FLORAL_PEEKABOO_GATEWAY_VERSION,
  assertObserveOnlyPeekabooToolSurface,
  buildObservationArtifactPath,
  buildPeekabooChildEnvironment,
  buildPeekabooClickArguments,
  buildPeekabooImageArguments,
  buildPeekabooMcpArguments,
  buildPeekabooSeeArguments,
  extractMcpTextContent,
  resolvePeekabooBridgeSocketPath,
} from "../src/config/mcp/peekaboo/floral-peekaboo-gateway.js";
import { resolveTrustedVisionArtifact } from "../src/config/mcp/vision/vision-input-policy.js";

const peekabooCommand = process.env.FLORAL_PEEKABOO_COMMAND?.trim() ?? "";
const allowedRoot = process.env.FLORAL_PEEKABOO_ALLOWED_ROOT?.trim() ?? "";

if (!peekabooCommand) {
  throw new Error("FLORAL_PEEKABOO_COMMAND must be explicitly injected by FLORAL");
}
if (!allowedRoot) {
  throw new Error("FLORAL_PEEKABOO_ALLOWED_ROOT must be explicitly injected by FLORAL");
}
await mkdir(allowedRoot, { recursive: true, mode: 0o700 });
const bridgeSocket = resolvePeekabooBridgeSocketPath();

type UpstreamConnection = {
  client: Client;
  transport: StdioClientTransport;
};

let upstream: UpstreamConnection | undefined;
let connecting: Promise<UpstreamConnection> | undefined;

async function connectUpstream(): Promise<UpstreamConnection> {
  if (upstream) return upstream;
  if (connecting) return await connecting;

  const bridgeStat = await stat(bridgeSocket).catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Peekaboo Bridge socket is unavailable at ${bridgeSocket}: ${detail}`,
    );
  });
  if (!bridgeStat.isSocket()) {
    throw new Error(
      `Peekaboo Bridge path is not a Unix socket: ${bridgeSocket}`,
    );
  }

  connecting = (async () => {
    const client = new Client({
      name: "floral-peekaboo-upstream-client",
      version: FLORAL_PEEKABOO_GATEWAY_VERSION,
    });
    const transport = new StdioClientTransport({
      command: peekabooCommand,
      args: buildPeekabooMcpArguments(bridgeSocket),
      env: buildPeekabooChildEnvironment(),
    });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      assertObserveOnlyPeekabooToolSurface(tools.tools.map((tool) => tool.name));
      const connection = { client, transport };
      upstream = connection;
      return connection;
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  })();

  try {
    return await connecting;
  } finally {
    connecting = undefined;
  }
}

async function callPeekaboo(
  toolName: "click" | "image" | "see",
  arguments_: Record<string, unknown>,
): Promise<string> {
  const connection = await connectUpstream();
  const result = await connection.client.callTool({
    name: toolName,
    arguments: arguments_,
  }) as {
    isError?: boolean;
    content?: Array<{ type?: string; text?: unknown }>;
  };
  const text = extractMcpTextContent(result);
  if (result.isError) {
    throw new Error(`Peekaboo ${toolName} failed${text ? `: ${text.slice(0, 1000)}` : ""}`);
  }
  return text;
}

async function capture(
  kind: "image" | "see",
  appTarget: string | undefined,
): Promise<{ artifactPath: string; upstreamText: string }> {
  const outputPath = buildObservationArtifactPath({
    allowedRoot,
    kind,
    token: randomUUID(),
  });
  const upstreamText = kind === "image"
    ? await callPeekaboo("image", buildPeekabooImageArguments(outputPath, { app_target: appTarget }))
    : await callPeekaboo("see", buildPeekabooSeeArguments(outputPath, { app_target: appTarget }));

  await chmod(outputPath, 0o600);
  const artifact = resolveTrustedVisionArtifact({
    artifactPath: outputPath,
    allowedRoot,
  });
  return {
    artifactPath: artifact.absolutePath,
    upstreamText,
  };
}

const appTargetSchema = z
  .string()
  .min(1)
  .max(256)
  .optional()
  .describe(
    "Optional observation target such as frontmost, screen:0, an application name, or PID:123. FLORAL controls the output path and capture mode.",
  );

const server = new McpServer({
  name: FLORAL_PEEKABOO_GATEWAY_NAME,
  version: FLORAL_PEEKABOO_GATEWAY_VERSION,
});

const snapshotSchema = z
  .string()
  .min(1)
  .max(256)
  .describe("Required fresh Snapshot ID returned by floral_peekaboo/see.");

const elementIdSchema = z
  .string()
  .min(1)
  .max(256)
  .describe("Required opaque element ID copied exactly from the same fresh floral_peekaboo/see output.");

const clickIntentSchema = z
  .string()
  .min(1)
  .max(160)
  .describe("Short model-declared purpose for this one click. It is shown in FLORAL's one-shot approval prompt.");

server.tool(
  "click",
  "Perform exactly one approval-gated background click on an opaque element ID from a fresh floral_peekaboo/see snapshot. Coordinates, text queries, foreground activation, right/double click, and explicit PIDs are unavailable. After success the referenced snapshot is invalidated; call floral_peekaboo/see again before any further GUI action.",
  {
    snapshot: snapshotSchema,
    on: elementIdSchema,
    intent: clickIntentSchema,
  },
  async ({ snapshot, on, intent }) => {
    try {
      const upstreamText = await callPeekaboo(
        "click",
        buildPeekabooClickArguments({ snapshot, on, intent }),
      );
      return {
        content: [{
          type: "text",
          text: [
            "source=floral_peekaboo/click",
            `declared_intent=${intent}`,
            upstreamText ? "peekaboo_result_begin" : "",
            upstreamText,
            upstreamText ? "peekaboo_result_end" : "",
            "next=The previous UI snapshot is stale. Call floral_peekaboo/see before any further GUI action.",
          ].filter(Boolean).join("\n"),
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        isError: true,
        content: [{ type: "text", text: `peekaboo_gateway_error=${message}` }],
      };
    }
  },
);

server.tool(
  "image",
  "Capture a read-only macOS screenshot through FLORAL's Peekaboo gateway. The model cannot choose the output path, inline/base64 mode, foreground focus, or Peekaboo AI analysis. Returns artifactPath inside FLORAL's trusted screenshot root. If the task requires pixel-level visual understanding or OCR, pass artifactPath to floral_vision/vision_analyze_screen.",
  {
    app_target: appTargetSchema,
  },
  async ({ app_target }) => {
    try {
      const result = await capture("image", app_target);
      return {
        content: [{
          type: "text",
          text: [
            `artifactPath=${result.artifactPath}`,
            "source=floral_peekaboo/image",
            "next=For visual semantics or OCR call floral_vision/vision_analyze_screen with artifactPath.",
          ].join("\n"),
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        isError: true,
        content: [{ type: "text", text: `peekaboo_gateway_error=${message}` }],
      };
    }
  },
);

server.tool(
  "see",
  "Inspect read-only macOS accessibility/UI state through FLORAL's Peekaboo gateway. The screenshot path, annotation mode, traversal budgets, and snapshot creation are controlled by FLORAL. Returns an artifactPath plus Peekaboo's accessibility summary. Use the summary directly when sufficient; otherwise pass artifactPath to floral_vision/vision_analyze_screen.",
  {
    app_target: appTargetSchema,
  },
  async ({ app_target }) => {
    try {
      const result = await capture("see", app_target);
      return {
        content: [{
          type: "text",
          text: [
            `artifactPath=${result.artifactPath}`,
            "source=floral_peekaboo/see",
            result.upstreamText ? "peekaboo_summary_begin" : "",
            result.upstreamText,
            result.upstreamText ? "peekaboo_summary_end" : "",
            "next=If accessibility text is insufficient, call floral_vision/vision_analyze_screen with artifactPath.",
          ].filter(Boolean).join("\n"),
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        isError: true,
        content: [{ type: "text", text: `peekaboo_gateway_error=${message}` }],
      };
    }
  },
);

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.once(signal, () => {
    void (async () => {
      await upstream?.client.close().catch(() => undefined);
      process.exit(0);
    })();
  });
}

await server.connect(new StdioServerTransport());
