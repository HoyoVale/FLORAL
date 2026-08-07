import { createHash } from "node:crypto";
import { assertLoopbackSearxngUrl } from "./searxng.js";

export interface SearxngRuntimeObservation {
  endpoint: string;
  status: "observed" | "unavailable" | "invalid" | "skipped";
  topLevelKeys: string[];
  engines: string[];
  plugins: string[];
  categories: string[];
  fingerprint?: string | undefined;
  errorType?: string | undefined;
}

export async function observeSearxngRuntime(
  baseUrl: string,
  timeoutMs: number,
  endpointPath: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SearxngRuntimeObservation> {
  const base = assertLoopbackSearxngUrl(baseUrl);
  const endpoint = new URL(endpointPath, ensureTrailingSlash(base));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(endpoint, {
      method: "GET",
      headers: {
        accept: "application/json",
        "user-agent": "FLORAL-SearXNG-Runtime-Observation/0.1",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      return emptySearxngRuntime(endpoint.toString(), "invalid", `HTTP_${String(response.status)}`);
    }
    const body = await response.json() as unknown;
    if (!isRecord(body)) return emptySearxngRuntime(endpoint.toString(), "invalid", "InvalidJsonShape");
    const engines = extractNamedEntries(body.engines);
    const plugins = extractNamedEntries(body.plugins);
    const categories = extractNamedEntries(body.categories);
    const safe = {
      topLevelKeys: Object.keys(body).sort(),
      engines,
      plugins,
      categories,
    };
    return {
      endpoint: endpoint.toString(),
      status: "observed",
      ...safe,
      fingerprint: fingerprint(safe),
    };
  } catch (error) {
    return emptySearxngRuntime(
      endpoint.toString(),
      "unavailable",
      controller.signal.aborted ? "Timeout" : safeErrorType(error),
    );
  } finally {
    clearTimeout(timer);
  }
}

export function skippedSearxngRuntime(baseUrl: string): SearxngRuntimeObservation {
  return {
    endpoint: baseUrl,
    status: "skipped",
    topLevelKeys: [],
    engines: [],
    plugins: [],
    categories: [],
  };
}

function emptySearxngRuntime(
  endpoint: string,
  status: "unavailable" | "invalid",
  errorType: string,
): SearxngRuntimeObservation {
  return {
    endpoint,
    status,
    topLevelKeys: [],
    engines: [],
    plugins: [],
    categories: [],
    errorType,
  };
}

function extractNamedEntries(value: unknown): string[] {
  if (isRecord(value)) return Object.keys(value).sort().slice(0, 300);
  if (!Array.isArray(value)) return [];
  const names = new Set<string>();
  for (const item of value) {
    if (typeof item === "string" && item.trim() !== "") names.add(item.trim());
    else if (isRecord(item)) {
      for (const key of ["name", "id", "engine", "category"]) {
        const candidate = item[key];
        if (typeof candidate === "string" && candidate.trim() !== "") {
          names.add(candidate.trim());
          break;
        }
      }
    }
  }
  return [...names].sort().slice(0, 300);
}

function ensureTrailingSlash(url: URL): URL {
  const copy = new URL(url);
  if (!copy.pathname.endsWith("/")) copy.pathname += "/";
  copy.search = "";
  copy.hash = "";
  return copy;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableStringify(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeErrorType(error: unknown): string {
  return error instanceof Error && error.name.trim() !== "" ? error.name : "Error";
}
