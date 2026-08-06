import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  assertLoopbackSearxngUrl,
  checkSearxng,
} from "../src/search/searxng.js";

describe("SearXNG integration boundary", () => {
  it("accepts a loopback JSON search endpoint", async () => {
    const server = createServer((request, response) => {
      expect(request.url).toContain("/search?");
      expect(request.url).toContain("format=json");
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        results: [{
          title: "SearXNG Search API",
          url: "https://docs.searxng.org/dev/search_api.html",
          engine: "duckduckgo",
        }],
      }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });

    try {
      const address = server.address() as AddressInfo;
      const result = await checkSearxng(
        `http://127.0.0.1:${address.port}`,
        2_000,
      );

      expect(result.resultCount).toBe(1);
      expect(result.previews[0]).toMatchObject({
        title: "SearXNG Search API",
        engine: "duckduckgo",
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    }
  });

  it("rejects non-loopback instances", () => {
    expect(() => assertLoopbackSearxngUrl("https://search.example.com"))
      .toThrow(/loopback|http/);
  });
});
