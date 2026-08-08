import { createHash } from "node:crypto";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadProjectEnv } from "../src/config/load-project-env.js";
import { resolveFloralVisionRuntime } from "../src/config/mcp/mcp-runtime-registry.js";
import {
  DEFAULT_MIMO_VISION_BASE_URL,
  DEFAULT_MIMO_VISION_MODEL,
  FLORAL_VISION_SERVER_NAME,
  FLORAL_VISION_SERVER_VERSION,
  FLORAL_VISION_TOOLS,
} from "../src/config/mcp/vision/floral-vision-contract.js";
import { resolveTrustedVisionArtifact } from "../src/config/mcp/vision/vision-input-policy.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadProjectEnv(join(repositoryRoot, ".env"));

const runtime = resolveFloralVisionRuntime();
const apiKey = process.env.MIMO_API_KEY?.trim() ?? "";
const baseUrl = DEFAULT_MIMO_VISION_BASE_URL;
const model = DEFAULT_MIMO_VISION_MODEL;

console.log(`vision.server=${FLORAL_VISION_SERVER_NAME}`);
console.log(`vision.version=${FLORAL_VISION_SERVER_VERSION}`);
console.log(`vision.tools=${FLORAL_VISION_TOOLS.join(",")}`);
console.log("vision.allowed_root=derived");
console.log(`vision.secret.mimo_api_key=${apiKey ? "present" : "missing"}`);
console.log(`vision.base_url=${baseUrl}`);
console.log(`vision.model=${model}`);

const url = new URL(baseUrl);
if (
  url.protocol !== "https:"
  || !(url.hostname === "xiaomimimo.com" || url.hostname.endsWith(".xiaomimimo.com"))
) {
  throw new Error("MiMo base URL is not an official HTTPS xiaomimimo.com endpoint");
}
if (!apiKey) {
  throw new Error("MIMO_API_KEY is required for the production probe");
}

await access(runtime.serverEntrypoint);
await mkdir(runtime.allowedRoot, { recursive: true, mode: 0o700 });

const probePath = join(
  runtime.allowedRoot,
  `.floral-vision-probe-${String(process.pid)}-${Date.now().toString(36)}.png`,
);
const client = new Client({
  name: "floral-vision-production-probe",
  version: "0.1.0",
});
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [runtime.serverEntrypoint],
  env: {
    FLORAL_VISION_ALLOWED_ROOT: runtime.allowedRoot,
    MIMO_BASE_URL: baseUrl,
    MIMO_VISION_MODEL: model,
    MIMO_API_KEY: apiKey,
  },
});

try {
  await writeFile(probePath, createProbePng(), { mode: 0o600 });
  const trusted = resolveTrustedVisionArtifact({
    artifactPath: probePath,
    allowedRoot: runtime.allowedRoot,
  });
  console.log(`vision.probe_artifact_bytes=${String(trusted.bytes)}`);

  await client.connect(transport);
  console.log("vision.mcp_connection=ok");

  const tools = await client.listTools();
  const actualTools = tools.tools.map((tool) => tool.name).sort();
  const expectedTools = [...FLORAL_VISION_TOOLS].sort();
  if (JSON.stringify(actualTools) !== JSON.stringify(expectedTools)) {
    throw new Error(
      `FLORAL vision MCP tool drift: expected ${expectedTools.join(",")}, received ${actualTools.join(",")}`,
    );
  }
  console.log(`vision.mcp_tools=${actualTools.join(",")}`);

  const result = await client.callTool({
    name: "vision_analyze_screen",
    arguments: {
      artifactPath: trusted.absolutePath,
      prompt:
        "This is a FLORAL production connectivity probe image. Briefly describe the visible geometric pattern. Do not infer anything beyond the image.",
    },
  }) as {
    isError?: boolean;
    content?: Array<{ type?: string; text?: string }>;
  };

  const responseText = result.content
    ?.filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text ?? "")
    .join("\n")
    .trim() ?? "";

  if (result.isError || !responseText) {
    throw new Error(
      `FLORAL vision MCP probe failed${responseText ? `: ${responseText.slice(0, 500)}` : ""}`,
    );
  }

  console.log("vision.api=ok");
  console.log(`vision.response_chars=${String(responseText.length)}`);
  console.log(
    `vision.response_sha256=${createHash("sha256").update(responseText).digest("hex")}`,
  );
  console.log("vision.probe=ok");
} finally {
  await client.close().catch(() => undefined);
  await rm(probePath, { force: true });
}

function createProbePng(): Buffer {
  const width = 32;
  const height = 32;
  const stride = 1 + width * 3;
  const raw = Buffer.alloc(stride * height);

  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 3;
      const light = ((x >> 3) + (y >> 3)) % 2 === 0;
      const value = light ? 240 : 32;
      raw[offset] = value;
      raw[offset + 1] = value;
      raw[offset + 2] = value;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBytes, data]);
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  typeBytes.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(body), 8 + data.length);
  return result;
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
