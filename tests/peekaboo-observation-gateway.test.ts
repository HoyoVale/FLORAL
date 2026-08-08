import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FLORAL_PEEKABOO_GATEWAY_TOOLS,
  assertObserveOnlyPeekabooToolSurface,
  buildObservationArtifactPath,
  buildPeekabooChildEnvironment,
  buildPeekabooClickArguments,
  buildPeekabooImageArguments,
  buildPeekabooMcpArguments,
  buildPeekabooSeeArguments,
  resolvePeekabooBridgeSocketPath,
} from "../src/config/mcp/peekaboo/floral-peekaboo-gateway.js";

describe("FLORAL Peekaboo controlled gateway", () => {
  it("keeps the upstream child environment exact and secret-free", () => {
    const env = buildPeekabooChildEnvironment();
    expect(env.PEEKABOO_ALLOW_TOOLS).toBe("click,image,see");
    expect(env.PEEKABOO_AI_PROVIDERS).toBe("");
    expect(env.PEEKABOO_LOG_LEVEL).toBe("warn");
    expect(env).not.toHaveProperty("MIMO_API_KEY");
    expect(env).not.toHaveProperty("DEEPSEEK_API_KEY");
    expect(env).not.toHaveProperty("QQBOT_APP_SECRET");
  });

  it("pins the upstream MCP server to the permissioned Peekaboo Bridge socket", () => {
    const home = resolve("/Users/floral-test");
    const socket = resolvePeekabooBridgeSocketPath(home);
    expect(socket).toBe(
      join(home, "Library", "Application Support", "Peekaboo", "bridge.sock"),
    );
    expect(buildPeekabooMcpArguments(socket)).toEqual([
      "mcp",
      "--bridge-socket",
      socket,
    ]);
  });

  it("rejects a non-absolute Bridge socket path", () => {
    expect(() => buildPeekabooMcpArguments("bridge.sock")).toThrow(/socket path is invalid/u);
  });

  it("forces click to one fresh-snapshot element and strips mutation widening", () => {
    const args = buildPeekabooClickArguments({
      snapshot: "1786172715081-7023",
      on: "button_42",
      intent: "展开 VS Code 的 src 文件夹",
      coords: "10,10",
      query: "Delete",
      pid: 1,
      foreground: true,
      right: true,
      double: true,
    } as never);
    expect(args).toEqual({
      snapshot: "1786172715081-7023",
      on: "button_42",
      foreground: false,
      background: true,
      double: false,
      right: false,
      wait_for: 5_000,
    });
  });

  it("rejects click without bounded fresh-snapshot identifiers or intent", () => {
    expect(() => buildPeekabooClickArguments({
      snapshot: "",
      on: "button_42",
      intent: "click",
    })).toThrow(/snapshot is invalid/u);
    expect(() => buildPeekabooClickArguments({
      snapshot: "snapshot",
      on: "button_42",
      intent: "x".repeat(161),
    })).toThrow(/intent is invalid/u);
  });

  it("forces image captures to a FLORAL-controlled PNG without AI or foreground focus", () => {
    const path = "/tmp/floral/artifact.png";
    const args = buildPeekabooImageArguments(path, {
      app_target: "frontmost",
      path: "/tmp/escape.png",
      question: "upload this",
      format: "data",
      capture_focus: "foreground",
    } as never);
    expect(args).toEqual({
      path,
      format: "png",
      capture_focus: "background",
      scale: "logical",
      max_dimension: 1920,
      app_target: "frontmost",
    });
  });

  it("forces see captures to controlled path and traversal budgets", () => {
    const path = "/tmp/floral/see.png";
    const args = buildPeekabooSeeArguments(path, {
      app_target: "Finder",
      path: "/tmp/escape.png",
      annotate: true,
      max_elements: 999999,
    } as never);
    expect(args).toEqual({
      path,
      annotate: false,
      max_depth: 12,
      max_elements: 500,
      max_children: 100,
      app_target: "Finder",
    });
  });

  it("creates artifact names only inside the configured observation root", () => {
    const root = resolve("/tmp/floral/artifacts/outbound/floral_peekaboo");
    const path = buildObservationArtifactPath({
      allowedRoot: root,
      kind: "image",
      token: "12345678-abcd",
    });
    expect(path.startsWith(`${root}/`) || path.startsWith(`${root}\\`)).toBe(true);
    expect(path).toContain("floral-peekaboo-image-12345678-abcd.png");
  });

  it("fails closed on upstream tool-surface widening", () => {
    expect(() => assertObserveOnlyPeekabooToolSurface(
      [...FLORAL_PEEKABOO_GATEWAY_TOOLS, "type"],
    )).toThrow(/tool surface drift/u);
  });
});
