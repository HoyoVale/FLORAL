export interface SearxngSearchPreview {
  title: string;
  url: string;
  engine?: string | undefined;
}

export interface SearxngHealthResult {
  endpoint: string;
  resultCount: number;
  previews: SearxngSearchPreview[];
}

export async function checkSearxng(
  baseUrl: string,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<SearxngHealthResult> {
  const normalizedBase = assertLoopbackSearxngUrl(baseUrl);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("SearXNG timeout must be a positive integer");
  }

  const endpoint = new URL("search", ensureTrailingSlash(normalizedBase));
  endpoint.searchParams.set("q", "FLORAL SearXNG health probe");
  endpoint.searchParams.set("format", "json");
  endpoint.searchParams.set("safesearch", "1");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(endpoint, {
      method: "GET",
      headers: {
        accept: "application/json",
        "user-agent": "FLORAL-SearXNG-Health/0.1",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`SearXNG health request failed with HTTP ${response.status}`);
    }

    const data = await response.json() as unknown;
    const record = asRecord(data);
    if (!record || !Array.isArray(record.results)) {
      throw new Error("SearXNG health response did not contain a results array");
    }

    return {
      endpoint: normalizedBase.toString().replace(/\/$/, ""),
      resultCount: record.results.length,
      previews: record.results
        .map(readPreview)
        .filter((value): value is SearxngSearchPreview => value !== undefined)
        .slice(0, 3),
    };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`SearXNG health request timed out after ${timeoutMs}ms`, {
        cause: error,
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function assertLoopbackSearxngUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:") {
    throw new Error("SEARXNG_URL must use http:// for the local loopback instance");
  }
  if (url.username || url.password) {
    throw new Error("SEARXNG_URL must not contain credentials");
  }

  const hostname = url.hostname.toLowerCase();
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname)) {
    throw new Error(`SEARXNG_URL must target loopback, received: ${url.hostname}`);
  }

  return url;
}

function ensureTrailingSlash(url: URL): URL {
  const copy = new URL(url);
  if (!copy.pathname.endsWith("/")) copy.pathname += "/";
  copy.search = "";
  copy.hash = "";
  return copy;
}

function readPreview(value: unknown): SearxngSearchPreview | undefined {
  const record = asRecord(value);
  if (!record || typeof record.title !== "string" || typeof record.url !== "string") {
    return undefined;
  }

  return {
    title: record.title,
    url: record.url,
    ...(typeof record.engine === "string" ? { engine: record.engine } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
}
