import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TranslatedDeepSeekRequest } from "../src/agent/bridge/bridge-types.js";
import {
  DeepSeekCostGuard,
  estimateDeepSeekCostCny,
  fingerprintTranslatedDeepSeekRequest,
  normalizeUsage,
  type DeepSeekCostGuardPolicy,
} from "../src/runtime/cost/deepseek-cost-guard.js";
import { ProviderActivityGate } from "../src/runtime/cost/provider-activity-gate.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function policy(overrides: Partial<DeepSeekCostGuardPolicy> = {}): DeepSeekCostGuardPolicy {
  return {
    enabled: true,
    state_path: "./data/cost-guard/deepseek.json",
    max_requests_per_minute: 20,
    max_requests_per_hour: 120,
    max_requests_per_day: 1_000,
    max_tokens_per_hour: 5_000_000,
    max_tokens_per_day: 20_000_000,
    max_cost_cny_per_hour: 2,
    max_cost_cny_per_day: 10,
    duplicate_window_ms: 300_000,
    duplicate_max_attempts: 4,
    max_unknown_usage_per_hour: 8,
    pricing: {
      model: "deepseek-v4-flash",
      input_cache_hit_cny_per_million: 0.02,
      input_cache_miss_cny_per_million: 1,
      output_cny_per_million: 2,
    },
    ...overrides,
  };
}

function request(callId = "call_1"): TranslatedDeepSeekRequest {
  return {
    model: "deepseek-v4-flash",
    messages: [
      { role: "system", content: "system" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: callId,
          type: "function",
          function: { name: "search", arguments: '{"q":"same"}' },
        }],
      },
      { role: "tool", tool_call_id: callId, content: "result" },
    ],
    tools: [{
      type: "function",
      function: {
        name: "search",
        parameters: { type: "object", properties: { q: { type: "string" } } },
      },
    }],
    toolMap: new Map(),
    parallelToolCalls: true,
  };
}

describe("DeepSeek cost guard", () => {
  it("prices cache-hit, cache-miss, output, and reasoning usage without double charging reasoning", () => {
    const usage = normalizeUsage({
      promptTokens: 1_000_000,
      promptCacheHitTokens: 900_000,
      promptCacheMissTokens: 100_000,
      completionTokens: 100_000,
      reasoningTokens: 80_000,
      totalTokens: 1_100_000,
    });
    expect(usage).toBeDefined();
    expect(usage?.reasoningTokens).toBe(80_000);
    expect(estimateDeepSeekCostCny(usage!, policy())).toBe(0.318);
  });

  it("normalizes volatile tool call ids before duplicate fingerprinting", () => {
    expect(fingerprintTranslatedDeepSeekRequest(request("call_a")))
      .toBe(fingerprintTranslatedDeepSeekRequest(request("call_b")));
  });

  it("blocks repeated semantically identical provider attempts before another API call", async () => {
    const root = await mkdtemp(join(tmpdir(), "floral-cost-"));
    roots.push(root);
    let nowMs = Date.parse("2026-08-07T00:00:00.000Z");
    const guard = new DeepSeekCostGuard({
      repositoryRoot: root,
      policy: policy({ duplicate_max_attempts: 2 }),
      now: () => new Date(nowMs),
    });

    const first = await guard.beginAttempt(request("call_a"));
    await guard.completeAttempt(first, {
      promptTokens: 10,
      promptCacheHitTokens: 0,
      promptCacheMissTokens: 10,
      completionTokens: 2,
      totalTokens: 12,
    }, "completed");
    nowMs += 1_000;
    const second = await guard.beginAttempt(request("call_b"));
    await guard.completeAttempt(second, undefined, "failed");
    nowMs += 1_000;

    await expect(guard.beginAttempt(request("call_c"))).rejects.toMatchObject({
      kind: "cost_limit",
      retryable: false,
      data: { code: "duplicate-request" },
    });

    const stored = await readFile(join(root, "data/cost-guard/deepseek.json"), "utf8");
    expect(stored).not.toContain("system");
    expect(stored).not.toContain("result");
    expect(stored).not.toContain("same");
  });

  it("persists rolling token and cost budgets across guard instances", async () => {
    const root = await mkdtemp(join(tmpdir(), "floral-cost-"));
    roots.push(root);
    const now = () => new Date("2026-08-07T00:00:00.000Z");
    const configured = policy({
      max_tokens_per_hour: 100,
      max_tokens_per_day: 200,
      max_cost_cny_per_hour: 10,
      max_cost_cny_per_day: 20,
    });
    const firstGuard = new DeepSeekCostGuard({ repositoryRoot: root, policy: configured, now });
    const lease = await firstGuard.beginAttempt(request());
    await firstGuard.completeAttempt(lease, {
      promptTokens: 90,
      promptCacheHitTokens: 0,
      promptCacheMissTokens: 90,
      completionTokens: 10,
      totalTokens: 100,
    }, "completed");

    const restarted = new DeepSeekCostGuard({ repositoryRoot: root, policy: configured, now });
    await expect(restarted.beginAttempt({ ...request(), messages: [{ role: "user", content: "different" }] }))
      .rejects.toMatchObject({ data: { code: "token-budget-hour" } });
    expect((await restarted.snapshot()).tokens.hour).toBe(100);
  });

  it("fails closed before provider I/O when the durable ledger is unreadable", async () => {
    const root = await mkdtemp(join(tmpdir(), "floral-cost-"));
    roots.push(root);
    const stateDirectory = join(root, "data/cost-guard");
    await mkdir(stateDirectory, { recursive: true });
    await writeFile(join(stateDirectory, "deepseek.json"), "{not-json\n", "utf8");
    const guard = new DeepSeekCostGuard({ repositoryRoot: root, policy: policy() });

    await expect(guard.beginAttempt(request())).rejects.toMatchObject({
      kind: "cost_limit",
      retryable: false,
      data: { code: "cost-guard-state-unavailable" },
    });
  });

  it("counts failed provider attempts with missing usage and eventually fails closed", async () => {
    const root = await mkdtemp(join(tmpdir(), "floral-cost-"));
    roots.push(root);
    let nowMs = Date.parse("2026-08-07T00:00:00.000Z");
    const guard = new DeepSeekCostGuard({
      repositoryRoot: root,
      policy: policy({ max_unknown_usage_per_hour: 2, duplicate_max_attempts: 10 }),
      now: () => new Date(nowMs),
    });
    for (let index = 0; index < 2; index += 1) {
      const lease = await guard.beginAttempt({
        ...request(),
        messages: [{ role: "user", content: `request-${String(index)}` }],
      });
      await guard.completeAttempt(lease, undefined, "failed");
      nowMs += 1_000;
    }
    await expect(guard.beginAttempt({
      ...request(),
      messages: [{ role: "user", content: "request-3" }],
    })).rejects.toMatchObject({ data: { code: "unknown-usage-budget" } });
  });
  it("enforces the idle invariant independently of token budgets", () => {
    const gate = new ProviderActivityGate();
    expect(() => gate.assertProviderRequestAllowed()).toThrow(/no agent run is active/u);
    const leave = gate.enterAgentRun();
    expect(() => gate.assertProviderRequestAllowed()).not.toThrow();
    expect(gate.snapshot()).toEqual({ activeRuns: 1, providerAllowed: true });
    leave();
    expect(gate.snapshot()).toEqual({ activeRuns: 0, providerAllowed: false });
  });

  it("allows only the explicitly trusted Codex memory-consolidation background activity", () => {
    const gate = new ProviderActivityGate();
    expect(() => gate.assertProviderRequestAllowed()).toThrow(/no agent run is active/u);
    expect(() => gate.assertProviderRequestAllowed({
      trustedNativeMemoryConsolidation: true,
    })).not.toThrow();
    expect(gate.snapshot()).toEqual({ activeRuns: 0, providerAllowed: false });
  });

});
