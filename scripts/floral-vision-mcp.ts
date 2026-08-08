import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  DEFAULT_MIMO_VISION_BASE_URL,
  DEFAULT_MIMO_VISION_MODEL,
  FLORAL_VISION_SERVER_NAME,
  FLORAL_VISION_SERVER_VERSION,
} from "../src/config/mcp/vision/floral-vision-contract.js";
import { analyzeImageWithMimo } from "../src/config/mcp/vision/mimo-vision-client.js";
import { resolveTrustedVisionArtifact } from "../src/config/mcp/vision/vision-input-policy.js";

const allowedRoot = process.env.FLORAL_VISION_ALLOWED_ROOT?.trim() ?? "";
const apiKey = process.env.MIMO_API_KEY?.trim() ?? "";
const baseUrl = process.env.MIMO_BASE_URL?.trim() || DEFAULT_MIMO_VISION_BASE_URL;
const model = process.env.MIMO_VISION_MODEL?.trim() || DEFAULT_MIMO_VISION_MODEL;

function mediaTypeFor(extension: string): "image/png" | "image/jpeg" | "image/webp" {
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  return "image/jpeg";
}

function validateRuntime(): void {
  if (!allowedRoot) {
    throw new Error("FLORAL_VISION_ALLOWED_ROOT must be explicitly injected by FLORAL");
  }
  if (!apiKey) {
    throw new Error("MIMO_API_KEY must be injected from a FLORAL SecretRef");
  }
}

async function analyze(artifactPath: string, prompt: string): Promise<string> {
  const artifact = resolveTrustedVisionArtifact({ artifactPath, allowedRoot });
  return analyzeImageWithMimo({
    apiKey,
    baseUrl,
    model,
    imagePath: artifact.absolutePath,
    mediaType: mediaTypeFor(artifact.extension),
    prompt,
  });
}

validateRuntime();

const server = new McpServer({
  name: FLORAL_VISION_SERVER_NAME,
  version: FLORAL_VISION_SERVER_VERSION,
});

const artifactPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .describe(
    "Path to a screenshot artifact already created by FLORAL. URLs, data URIs, raw base64, symlinks, hardlinks, and files outside the configured screenshot root are rejected.",
  );

server.tool(
  "vision_analyze_screen",
  "Analyze a FLORAL-generated screenshot with MiMo and return text for the primary DeepSeek/Codex model.",
  {
    artifactPath: artifactPathSchema,
    prompt: z.string().min(1).max(4000).optional(),
  },
  async ({ artifactPath, prompt }) => {
    try {
      const text = await analyze(
        artifactPath,
        prompt?.trim() ||
          "Describe the visible application state, important text, errors, dialogs, controls, and anything relevant for an automation agent. Do not guess content that is not visible.",
      );
      return { content: [{ type: "text", text }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { isError: true, content: [{ type: "text", text: `vision_error=${message}` }] };
    }
  },
);

server.tool(
  "vision_analyze_region",
  "Analyze a region of a FLORAL-generated screenshot. Coordinates are normalized to the full image and are passed as a focus hint; this tool never reads another file.",
  {
    artifactPath: artifactPathSchema,
    region: z.object({
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      width: z.number().positive().max(1),
      height: z.number().positive().max(1),
    }),
    prompt: z.string().min(1).max(4000).optional(),
  },
  async ({ artifactPath, region, prompt }) => {
    try {
      if (region.x + region.width > 1 || region.y + region.height > 1) {
        throw new Error("Vision region must remain inside normalized image bounds");
      }
      const focus = `Focus on normalized image rectangle x=${region.x}, y=${region.y}, width=${region.width}, height=${region.height}.`;
      const text = await analyze(
        artifactPath,
        `${focus}\n${prompt?.trim() || "Describe the visible UI, text, state, and errors in this region only. Do not guess content outside the region."}`,
      );
      return { content: [{ type: "text", text }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { isError: true, content: [{ type: "text", text: `vision_error=${message}` }] };
    }
  },
);

await server.connect(new StdioServerTransport());
