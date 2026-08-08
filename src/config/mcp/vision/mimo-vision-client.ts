import { readFile } from "node:fs/promises";

const OFFICIAL_MIMO_HOST_SUFFIX = ".xiaomimimo.com";

export type MimoVisionRequest = {
  apiKey: string;
  baseUrl: string;
  model: string;
  imagePath: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  prompt: string;
  timeoutMs?: number;
};

function validateOfficialBaseUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:") {
    throw new Error("MiMo base URL must use HTTPS");
  }
  const host = url.hostname.toLowerCase();
  if (host !== "xiaomimimo.com" && !host.endsWith(OFFICIAL_MIMO_HOST_SUFFIX)) {
    throw new Error("MiMo base URL must use an official xiaomimimo.com host");
  }
  return url;
}

function chatCompletionsUrl(baseUrl: string): URL {
  const base = validateOfficialBaseUrl(baseUrl);
  const normalizedPath = base.pathname.replace(/\/+$/, "");
  if (normalizedPath.endsWith("/chat/completions")) return base;
  base.pathname = `${normalizedPath}/chat/completions`.replace(/\/+/g, "/");
  return base;
}

export async function analyzeImageWithMimo(request: MimoVisionRequest): Promise<string> {
  const apiKey = request.apiKey.trim();
  const model = request.model.trim();
  const prompt = request.prompt.trim();
  if (!apiKey) throw new Error("MiMo API key is missing");
  if (!model) throw new Error("MiMo vision model is missing");
  if (!prompt) throw new Error("MiMo vision prompt is empty");

  const image = await readFile(request.imagePath);
  const dataUrl = `data:${request.mediaType};base64,${image.toString("base64")}`;
  const endpoint = chatCompletionsUrl(request.baseUrl);
  const timeoutMs = request.timeoutMs ?? 60_000;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: dataUrl } },
            { type: "text", text: prompt },
          ],
        },
      ],
      max_completion_tokens: 2048,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`MiMo API HTTP ${response.status}: ${body.slice(0, 500)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("MiMo API returned non-JSON content");
  }

  const text = (parsed as {
    choices?: Array<{ message?: { content?: unknown } }>;
  }).choices?.[0]?.message?.content;

  if (typeof text !== "string" || !text.trim()) {
    throw new Error("MiMo API returned an empty or unexpected vision response");
  }
  return text.trim();
}
