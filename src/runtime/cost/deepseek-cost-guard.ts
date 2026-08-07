import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { DeepSeekStreamChunk, TranslatedDeepSeekRequest } from "../../agent/bridge/bridge-types.js";
import { ModelProviderError } from "../../agent/provider/provider-errors.js";
import { acquireProcessLock, ProcessAlreadyRunningError } from "../process-lock.js";

export const DEEPSEEK_COST_GUARD_SCHEMA_VERSION = 1 as const;
const MILLION = 1_000_000;
const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const MINUTE_MS = 60 * 1_000;

export interface DeepSeekCostGuardPolicy {
  enabled: boolean;
  state_path: string;
  max_requests_per_minute: number;
  max_requests_per_hour: number;
  max_requests_per_day: number;
  max_tokens_per_hour: number;
  max_tokens_per_day: number;
  max_cost_cny_per_hour: number;
  max_cost_cny_per_day: number;
  duplicate_window_ms: number;
  duplicate_max_attempts: number;
  max_unknown_usage_per_hour: number;
  pricing: {
    model: string;
    input_cache_hit_cny_per_million: number;
    input_cache_miss_cny_per_million: number;
    output_cny_per_million: number;
  };
}

export interface DeepSeekCostUsage {
  promptTokens: number;
  promptCacheHitTokens: number;
  promptCacheMissTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export type CostGuardAttemptStatus = "started" | "completed" | "failed" | "cancelled";

interface CostGuardAttemptRecord {
  id: string;
  startedAt: string;
  completedAt?: string | undefined;
  fingerprint: string;
  model: string;
  status: CostGuardAttemptStatus;
  usage?: DeepSeekCostUsage | undefined;
  estimatedCostCny?: number | undefined;
  usageMissing?: boolean | undefined;
}

interface CostGuardState {
  schemaVersion: typeof DEEPSEEK_COST_GUARD_SCHEMA_VERSION;
  attempts: CostGuardAttemptRecord[];
}

export interface DeepSeekCostGuardSnapshot {
  enabled: boolean;
  statePath: string;
  requests: {
    minute: number;
    hour: number;
    day: number;
  };
  limits: {
    requestsMinute: number;
    requestsHour: number;
    requestsDay: number;
    tokensHour: number;
    tokensDay: number;
    costCnyHour: number;
    costCnyDay: number;
  };
  tokens: {
    hour: number;
    day: number;
  };
  estimatedCostCny: {
    hour: number;
    day: number;
  };
  unknownUsageHour: number;
  lastAttemptAt?: string | undefined;
  blockedReason?: CostGuardBlockCode | undefined;
  retryAfterMs?: number | undefined;
}

export type CostGuardBlockCode =
  | "request-rate-minute"
  | "request-rate-hour"
  | "request-rate-day"
  | "token-budget-hour"
  | "token-budget-day"
  | "cost-budget-hour"
  | "cost-budget-day"
  | "duplicate-request"
  | "unknown-usage-budget";

export interface CostGuardAttemptLease {
  id: string;
  fingerprint: string;
}

export interface DeepSeekCostGuardOptions {
  repositoryRoot: string;
  policy: DeepSeekCostGuardPolicy;
  now?: (() => Date) | undefined;
}

export class DeepSeekCostGuard {
  readonly #policy: DeepSeekCostGuardPolicy;
  readonly #statePath: string;
  readonly #now: () => Date;
  #fatalError: Error | undefined;
  #mutex: Promise<void> = Promise.resolve();

  constructor(options: DeepSeekCostGuardOptions) {
    const repositoryRoot = resolve(options.repositoryRoot);
    this.#policy = structuredClone(options.policy);
    this.#statePath = isAbsolute(this.#policy.state_path)
      ? this.#policy.state_path
      : resolve(repositoryRoot, this.#policy.state_path);
    this.#now = options.now ?? (() => new Date());
  }

  async beginAttempt(request: TranslatedDeepSeekRequest): Promise<CostGuardAttemptLease> {
    const fingerprint = fingerprintTranslatedDeepSeekRequest(request);
    if (!this.#policy.enabled) return { id: randomUUID(), fingerprint };
    if (this.#fatalError) throw costGuardStateError(this.#fatalError);

    try {
      return await this.#exclusive(async () => {
        if (this.#fatalError) throw costGuardStateError(this.#fatalError);
        const now = this.#now();
        const state = await this.#loadState();
        pruneState(state, now.getTime());
        const block = evaluatePolicy(state, this.#policy, now.getTime(), fingerprint);
        if (block) throw costGuardError(block.code, block.retryAfterMs);

        const attempt: CostGuardAttemptRecord = {
          id: randomUUID(),
          startedAt: now.toISOString(),
          fingerprint,
          model: request.model,
          status: "started",
        };
        state.attempts.push(attempt);
        await this.#persistState(state);
        return { id: attempt.id, fingerprint };
      });
    } catch (error) {
      if (error instanceof ModelProviderError && error.kind === "cost_limit") throw error;
      const fatal = error instanceof Error ? error : new Error(String(error));
      this.#fatalError = fatal;
      throw costGuardStateError(fatal);
    }
  }

  async completeAttempt(
    lease: CostGuardAttemptLease,
    usage: DeepSeekStreamChunk["usage"],
    status: Exclude<CostGuardAttemptStatus, "started">,
  ): Promise<void> {
    if (!this.#policy.enabled) return;

    try {
      await this.#exclusive(async () => {
        const state = await this.#loadState();
        const attempt = state.attempts.find((entry) => entry.id === lease.id);
        if (!attempt || attempt.status !== "started") return;
        const normalizedUsage = normalizeUsage(usage);
        attempt.status = status;
        attempt.completedAt = this.#now().toISOString();
        attempt.usageMissing = normalizedUsage === undefined;
        if (normalizedUsage) {
          attempt.usage = normalizedUsage;
          attempt.estimatedCostCny = estimateDeepSeekCostCny(normalizedUsage, this.#policy);
        }
        pruneState(state, this.#now().getTime());
        await this.#persistState(state);
      });
    } catch (error) {
      this.#fatalError = error instanceof Error ? error : new Error(String(error));
      throw error;
    }
  }

  async snapshot(): Promise<DeepSeekCostGuardSnapshot> {
    if (!this.#policy.enabled) {
      return {
        enabled: false,
        statePath: this.#statePath,
        requests: { minute: 0, hour: 0, day: 0 },
        limits: this.#limitsSnapshot(),
        tokens: { hour: 0, day: 0 },
        estimatedCostCny: { hour: 0, day: 0 },
        unknownUsageHour: 0,
      };
    }
    if (this.#fatalError) throw costGuardStateError(this.#fatalError);
    try {
      return await this.#exclusive(async () => {
        const now = this.#now();
        const state = await this.#loadState();
        pruneState(state, now.getTime());
        const aggregates = aggregateState(state, now.getTime());
        const block = evaluatePolicy(state, this.#policy, now.getTime());
        return {
          enabled: true,
          statePath: this.#statePath,
          requests: aggregates.requests,
          limits: this.#limitsSnapshot(),
          tokens: aggregates.tokens,
          estimatedCostCny: aggregates.estimatedCostCny,
          unknownUsageHour: aggregates.unknownUsageHour,
          ...(state.attempts.at(-1)?.startedAt ? { lastAttemptAt: state.attempts.at(-1)?.startedAt } : {}),
          ...(block ? { blockedReason: block.code, retryAfterMs: block.retryAfterMs } : {}),
        };
      });
    } catch (error) {
      if (error instanceof ModelProviderError && error.kind === "cost_limit") throw error;
      throw costGuardStateError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #limitsSnapshot(): DeepSeekCostGuardSnapshot["limits"] {
    return {
      requestsMinute: this.#policy.max_requests_per_minute,
      requestsHour: this.#policy.max_requests_per_hour,
      requestsDay: this.#policy.max_requests_per_day,
      tokensHour: this.#policy.max_tokens_per_hour,
      tokensDay: this.#policy.max_tokens_per_day,
      costCnyHour: this.#policy.max_cost_cny_per_hour,
      costCnyDay: this.#policy.max_cost_cny_per_day,
    };
  }

  async #loadState(): Promise<CostGuardState> {
    let source: string;
    try {
      source = await readFile(this.#statePath, "utf8");
    } catch (error) {
      if (isNotFound(error)) {
        return { schemaVersion: DEEPSEEK_COST_GUARD_SCHEMA_VERSION, attempts: [] };
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(source) as unknown;
    } catch (error) {
      throw new Error(`DeepSeek cost guard state is invalid JSON: ${this.#statePath}`, { cause: error });
    }
    return parseState(parsed, this.#statePath);
  }

  async #persistState(state: CostGuardState): Promise<void> {
    const directory = dirname(this.#statePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700).catch(() => undefined);
    const temporary = `${this.#statePath}.tmp-${String(process.pid)}-${Date.now().toString(36)}`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8" });
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await chmod(temporary, 0o600).catch(() => undefined);
      await rename(temporary, this.#statePath);
      await chmod(this.#statePath, 0o600).catch(() => undefined);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#mutex;
    let releaseMutex!: () => void;
    this.#mutex = new Promise<void>((resolvePromise) => {
      releaseMutex = resolvePromise;
    });
    await previous;
    let fileLock: Awaited<ReturnType<typeof acquireProcessLock>> | undefined;
    try {
      fileLock = await this.#acquireStateLock();
      return await operation();
    } finally {
      await fileLock?.release().catch(() => undefined);
      releaseMutex();
    }
  }

  async #acquireStateLock(): Promise<Awaited<ReturnType<typeof acquireProcessLock>>> {
    const lockPath = `${this.#statePath}.lock`;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        return await acquireProcessLock(lockPath);
      } catch (error) {
        if (!(error instanceof ProcessAlreadyRunningError)) throw error;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
      }
    }
    throw new Error("DeepSeek cost guard state lock remained busy for 2 seconds");
  }

}

export function fingerprintTranslatedDeepSeekRequest(request: TranslatedDeepSeekRequest): string {
  const callIds = new Map<string, string>();
  let nextCallId = 1;
  const normalizeCallId = (value: string | undefined): string | undefined => {
    if (!value) return undefined;
    const existing = callIds.get(value);
    if (existing) return existing;
    const normalized = `<call-${String(nextCallId)}>`;
    nextCallId += 1;
    callIds.set(value, normalized);
    return normalized;
  };

  const normalized = {
    model: request.model,
    messages: request.messages.map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
      ...(message.tool_call_id ? { tool_call_id: normalizeCallId(message.tool_call_id) } : {}),
      ...(message.tool_calls ? {
        tool_calls: message.tool_calls.map((call) => ({
          id: normalizeCallId(call.id),
          type: call.type,
          function: call.function,
        })),
      } : {}),
    })),
    tools: request.tools,
    maxTokens: request.maxTokens ?? null,
    parallelToolCalls: request.parallelToolCalls,
  };
  return createHash("sha256").update(stableStringify(normalized)).digest("hex");
}

export function normalizeUsage(
  usage: DeepSeekStreamChunk["usage"],
): DeepSeekCostUsage | undefined {
  if (!usage) return undefined;
  const promptTokens = nonNegative(usage.promptTokens);
  const completionTokens = nonNegative(usage.completionTokens);
  const totalTokens = nonNegative(usage.totalTokens);
  const cacheHit = nonNegative(usage.promptCacheHitTokens);
  const cacheMiss = nonNegative(usage.promptCacheMissTokens);
  const reasoning = nonNegative(usage.reasoningTokens);
  if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) {
    return undefined;
  }
  const resolvedPrompt = promptTokens ?? (cacheHit ?? 0) + (cacheMiss ?? 0);
  const resolvedCompletion = completionTokens ?? Math.max(0, (totalTokens ?? 0) - resolvedPrompt);
  const resolvedHit = Math.min(resolvedPrompt, cacheHit ?? 0);
  const resolvedMiss = cacheMiss ?? Math.max(0, resolvedPrompt - resolvedHit);
  return {
    promptTokens: resolvedPrompt,
    promptCacheHitTokens: resolvedHit,
    promptCacheMissTokens: Math.min(resolvedPrompt, resolvedMiss),
    completionTokens: resolvedCompletion,
    reasoningTokens: Math.min(resolvedCompletion, reasoning ?? 0),
    totalTokens: totalTokens ?? resolvedPrompt + resolvedCompletion,
  };
}

export function estimateDeepSeekCostCny(
  usage: DeepSeekCostUsage,
  policy: DeepSeekCostGuardPolicy,
): number {
  const pricedHit = Math.min(usage.promptTokens, usage.promptCacheHitTokens);
  const pricedMiss = Math.max(0, usage.promptTokens - pricedHit);
  return roundMoney(
    (pricedHit / MILLION) * policy.pricing.input_cache_hit_cny_per_million
    + (pricedMiss / MILLION) * policy.pricing.input_cache_miss_cny_per_million
    + (usage.completionTokens / MILLION) * policy.pricing.output_cny_per_million,
  );
}

export async function readDeepSeekCostGuardSnapshot(
  repositoryRoot: string,
  policy: DeepSeekCostGuardPolicy,
): Promise<DeepSeekCostGuardSnapshot> {
  return await new DeepSeekCostGuard({ repositoryRoot, policy }).snapshot();
}

function evaluatePolicy(
  state: CostGuardState,
  policy: DeepSeekCostGuardPolicy,
  nowMs: number,
  fingerprint?: string,
): { code: CostGuardBlockCode; retryAfterMs: number } | undefined {
  const totals = aggregateState(state, nowMs);
  if (totals.requests.minute >= policy.max_requests_per_minute) {
    return { code: "request-rate-minute", retryAfterMs: retryAfter(state, nowMs, MINUTE_MS) };
  }
  if (totals.requests.hour >= policy.max_requests_per_hour) {
    return { code: "request-rate-hour", retryAfterMs: retryAfter(state, nowMs, HOUR_MS) };
  }
  if (totals.requests.day >= policy.max_requests_per_day) {
    return { code: "request-rate-day", retryAfterMs: retryAfter(state, nowMs, DAY_MS) };
  }
  if (totals.tokens.hour >= policy.max_tokens_per_hour) {
    return { code: "token-budget-hour", retryAfterMs: retryAfterUsage(state, nowMs, HOUR_MS) };
  }
  if (totals.tokens.day >= policy.max_tokens_per_day) {
    return { code: "token-budget-day", retryAfterMs: retryAfterUsage(state, nowMs, DAY_MS) };
  }
  if (totals.estimatedCostCny.hour >= policy.max_cost_cny_per_hour) {
    return { code: "cost-budget-hour", retryAfterMs: retryAfterUsage(state, nowMs, HOUR_MS) };
  }
  if (totals.estimatedCostCny.day >= policy.max_cost_cny_per_day) {
    return { code: "cost-budget-day", retryAfterMs: retryAfterUsage(state, nowMs, DAY_MS) };
  }
  if (totals.unknownUsageHour >= policy.max_unknown_usage_per_hour) {
    return { code: "unknown-usage-budget", retryAfterMs: retryAfterUsage(state, nowMs, HOUR_MS) };
  }
  if (fingerprint) {
    const duplicateCutoff = nowMs - policy.duplicate_window_ms;
    const duplicates = state.attempts.filter((attempt) =>
      Date.parse(attempt.startedAt) >= duplicateCutoff && attempt.fingerprint === fingerprint
    );
    if (duplicates.length >= policy.duplicate_max_attempts) {
      const oldest = duplicates.map((attempt) => Date.parse(attempt.startedAt)).sort((a, b) => a - b)[0] ?? nowMs;
      return {
        code: "duplicate-request",
        retryAfterMs: Math.max(1_000, oldest + policy.duplicate_window_ms - nowMs),
      };
    }
  }
  return undefined;
}

function aggregateState(state: CostGuardState, nowMs: number): {
  requests: { minute: number; hour: number; day: number };
  tokens: { hour: number; day: number };
  estimatedCostCny: { hour: number; day: number };
  unknownUsageHour: number;
} {
  let requestsMinute = 0;
  let requestsHour = 0;
  let requestsDay = 0;
  let tokensHour = 0;
  let tokensDay = 0;
  let costHour = 0;
  let costDay = 0;
  let unknownUsageHour = 0;
  for (const attempt of state.attempts) {
    const started = Date.parse(attempt.startedAt);
    const age = nowMs - started;
    if (age <= MINUTE_MS) requestsMinute += 1;
    if (age <= HOUR_MS) {
      requestsHour += 1;
      tokensHour += attempt.usage?.totalTokens ?? 0;
      costHour += attempt.estimatedCostCny ?? 0;
      if (attempt.status !== "started" && attempt.usageMissing) unknownUsageHour += 1;
    }
    if (age <= DAY_MS) {
      requestsDay += 1;
      tokensDay += attempt.usage?.totalTokens ?? 0;
      costDay += attempt.estimatedCostCny ?? 0;
    }
  }
  return {
    requests: { minute: requestsMinute, hour: requestsHour, day: requestsDay },
    tokens: { hour: tokensHour, day: tokensDay },
    estimatedCostCny: { hour: roundMoney(costHour), day: roundMoney(costDay) },
    unknownUsageHour,
  };
}

function pruneState(state: CostGuardState, nowMs: number): void {
  const cutoff = nowMs - DAY_MS;
  state.attempts = state.attempts.filter((attempt) => Date.parse(attempt.startedAt) >= cutoff);
}

function retryAfter(state: CostGuardState, nowMs: number, windowMs: number): number {
  const cutoff = nowMs - windowMs;
  const oldest = state.attempts
    .map((attempt) => Date.parse(attempt.startedAt))
    .filter((started) => started >= cutoff)
    .sort((a, b) => a - b)[0] ?? nowMs;
  return Math.max(1_000, oldest + windowMs - nowMs);
}

function retryAfterUsage(state: CostGuardState, nowMs: number, windowMs: number): number {
  const cutoff = nowMs - windowMs;
  const oldest = state.attempts
    .filter((attempt) => attempt.usage || attempt.usageMissing)
    .map((attempt) => Date.parse(attempt.startedAt))
    .filter((started) => started >= cutoff)
    .sort((a, b) => a - b)[0] ?? nowMs;
  return Math.max(1_000, oldest + windowMs - nowMs);
}

function costGuardError(code: CostGuardBlockCode, retryAfterMs: number): ModelProviderError {
  return new ModelProviderError({
    kind: "cost_limit",
    message: `FLORAL DeepSeek cost guard blocked provider request: ${code}`,
    retryable: false,
    status: 429,
    retryAfterMs,
    data: { code },
  });
}

function costGuardStateError(cause: Error): ModelProviderError {
  return new ModelProviderError({
    kind: "cost_limit",
    message: "FLORAL DeepSeek cost guard is fail-closed because its durable state could not be updated",
    retryable: false,
    status: 429,
    data: { code: "cost-guard-state-unavailable" },
    cause,
  });
}

function parseState(value: unknown, path: string): CostGuardState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`DeepSeek cost guard state must be an object: ${path}`);
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== DEEPSEEK_COST_GUARD_SCHEMA_VERSION || !Array.isArray(record.attempts)) {
    throw new Error(`Unsupported DeepSeek cost guard state schema: ${path}`);
  }
  for (const attempt of record.attempts) {
    if (!isAttemptRecord(attempt)) throw new Error(`Invalid DeepSeek cost guard attempt record: ${path}`);
  }
  return record as unknown as CostGuardState;
}

function isAttemptRecord(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string"
    && typeof record.startedAt === "string"
    && typeof record.fingerprint === "string"
    && typeof record.model === "string"
    && ["started", "completed", "failed", "cancelled"].includes(String(record.status));
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function nonNegative(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}
