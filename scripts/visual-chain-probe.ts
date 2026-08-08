import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadProjectEnv } from "../src/config/load-project-env.js";
import { resolveConfigurationAuthority } from "../src/config/federation/config-authority.js";
import {
  resolveFloralPeekabooRuntime,
  resolveFloralVisionRuntime,
} from "../src/config/mcp/mcp-runtime-registry.js";
import {
  DEFAULT_MIMO_VISION_BASE_URL,
  DEFAULT_MIMO_VISION_MODEL,
} from "../src/config/mcp/vision/floral-vision-contract.js";
import { resolveTrustedVisionArtifact } from "../src/config/mcp/vision/vision-input-policy.js";
import {
  FLORAL_PEEKABOO_GATEWAY_TOOLS,
  extractMcpTextContent,
} from "../src/config/mcp/peekaboo/floral-peekaboo-gateway.js";

if (process.platform !== "darwin") {
  throw new Error("visual-chain:probe is macOS-only");
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadProjectEnv(join(repositoryRoot, ".env"));

const authority = await resolveConfigurationAuthority({
  repositoryRoot,
  environment: process.env,
});
if (!authority.effective.mcp.macos.enabled || !authority.effective.mcp.vision.enabled) {
  throw new Error("visual-chain:probe requires both mcp.macos and mcp.vision enabled");
}

const apiKey = process.env.MIMO_API_KEY?.trim() ?? "";
if (!apiKey) throw new Error("MIMO_API_KEY is required for visual-chain:probe");

const peekabooRuntime = resolveFloralPeekabooRuntime();
const visionRuntime = resolveFloralVisionRuntime();
let artifactPath: string | undefined;

const peekabooClient = new Client({
  name: "floral-visual-chain-peekaboo-probe",
  version: "0.1.0",
});
const peekabooTransport = new StdioClientTransport({
  command: process.execPath,
  args: [peekabooRuntime.serverEntrypoint],
  env: {
    FLORAL_PEEKABOO_COMMAND: authority.effective.macos.peekaboo_command,
    FLORAL_PEEKABOO_ALLOWED_ROOT: peekabooRuntime.allowedRoot,
  },
});

const visionClient = new Client({
  name: "floral-visual-chain-vision-probe",
  version: "0.1.0",
});
const visionTransport = new StdioClientTransport({
  command: process.execPath,
  args: [visionRuntime.serverEntrypoint],
  env: {
    FLORAL_VISION_ALLOWED_ROOT: visionRuntime.allowedRoot,
    MIMO_BASE_URL: DEFAULT_MIMO_VISION_BASE_URL,
    MIMO_VISION_MODEL: DEFAULT_MIMO_VISION_MODEL,
    MIMO_API_KEY: apiKey,
  },
});

try {
  await peekabooClient.connect(peekabooTransport);
  const peekabooTools = (await peekabooClient.listTools()).tools.map((tool) => tool.name).sort();
  if (JSON.stringify(peekabooTools) !== JSON.stringify([...FLORAL_PEEKABOO_GATEWAY_TOOLS].sort())) {
    throw new Error(`FLORAL Peekaboo gateway tool drift: ${peekabooTools.join(",")}`);
  }
  console.log(`visual_chain.peekaboo_tools=${peekabooTools.join(",")}`);

  const capture = await peekabooClient.callTool({
    name: "image",
    arguments: {},
  }) as {
    isError?: boolean;
    content?: Array<{ type?: string; text?: unknown }>;
  };
  const captureText = extractMcpTextContent(capture);
  if (capture.isError) {
    throw new Error(`FLORAL Peekaboo gateway capture failed: ${captureText.slice(0, 500)}`);
  }
  artifactPath = extractArtifactPath(captureText);
  const trusted = resolveTrustedVisionArtifact({
    artifactPath,
    allowedRoot: peekabooRuntime.allowedRoot,
  });
  console.log(`visual_chain.capture_bytes=${String(trusted.bytes)}`);
  console.log("visual_chain.peekaboo=ok");

  await visionClient.connect(visionTransport);
  const vision = await visionClient.callTool({
    name: "vision_analyze_screen",
    arguments: {
      artifactPath: trusted.absolutePath,
      prompt:
        "FLORAL visual-chain connectivity probe. Briefly describe the visible application/screen state and prominent UI structure. Do not infer hidden or sensitive information.",
    },
  }) as {
    isError?: boolean;
    content?: Array<{ type?: string; text?: unknown }>;
  };
  const visionText = extractMcpTextContent(vision);
  if (vision.isError || !visionText) {
    throw new Error(`FLORAL visual-chain vision failed: ${visionText.slice(0, 500)}`);
  }

  console.log("visual_chain.vision=ok");
  console.log(`visual_chain.response_chars=${String(visionText.length)}`);
  console.log(
    `visual_chain.response_sha256=${createHash("sha256").update(visionText).digest("hex")}`,
  );
  console.log("visual_chain.probe=ok");
} finally {
  await Promise.allSettled([
    peekabooClient.close(),
    visionClient.close(),
  ]);
  if (artifactPath) await rm(artifactPath, { force: true });
}

function extractArtifactPath(text: string): string {
  const line = text
    .split(/\r?\n/u)
    .find((value) => value.startsWith("artifactPath="));
  const value = line?.slice("artifactPath=".length).trim();
  if (!value) throw new Error("FLORAL Peekaboo gateway did not return artifactPath");
  return value;
}
