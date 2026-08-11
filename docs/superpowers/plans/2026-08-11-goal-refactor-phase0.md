# Goal 重构 Phase 0（方案 B）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 移除 FLORAL 自建的 Goal 自动续跑调度器，让 Codex app-server 成为 Goal 唯一权威，FLORAL 只保留 owner 命令 + 飞书 PATCH 状态卡 + 卡片控制桥接。

**Architecture:** 删除 `goal-continuation-coordinator` / `goal-continuation-support` / `gateway-goal-control` 与 `goal_continuation` 持久化、`goal.continuation` 配置、`/goal continue|restart` 命令；`gateway-goal-continuation.ts` 重构为无协调器的 `GoalStatusFacade`（状态卡生命周期 + 原生 Goal 快照 + 控制桥接）；gateway 只保留状态卡钩子。

**Tech Stack:** TypeScript 5.9 / Node 22 / pnpm / vitest 3 / better-sqlite3 / Feishu SDK 1.36.0。

## Global Constraints

- Git commit/push 由 owner 执行（AGENTS.md），任务以“全量测试绿”为完成门槛，owner 在检查点提交。
- 行数预算测试用例将被删除（owner 决定：行数预算是钝刀，不再作为硬门槛）；`tests/reliability-architecture.test.ts` 仅保留恢复矩阵与 owner 发布边界断言。
- 配置清单测试（`tests/config-inventory.test.ts`）的环境键计数必须与 `.env.example`/schema 一致。
- 飞书状态卡仍是核心交付：目标全文显式声明在 PATCH 卡片上；`/goal set` 回复保持简短。
- 不引入新的第二完成信号；native Goal（`thread/goal/*`）是唯一状态权威。
- 代码库已有结构预算：`src/service/gateway.ts ≤2950`、`src/agent/codex-app-server.ts ≤3400`、`src/service/gateway-goals.ts ≤150`。

---

## File Structure

**删除：**
- `src/service/goal-continuation-coordinator.ts`
- `src/service/goal-continuation-support.ts`
- `src/service/gateway-goal-control.ts`（重写为无 coordinator 后再删除旧语义；见 Task 1）
- `tests/goal-continuation-coordinator.test.ts`
- `tests/gateway-goal-control.test.ts`

**重写：**
- `src/service/gateway-goal-control.ts` → 无 coordinator 的纯桥接（pause/stop/continue/restart → native Goal + 中断）
- `src/service/gateway-goal-continuation.ts` → `GoalStatusFacade`（保留文件名，只暴露状态卡/快照/控制）

**修改：**
- `src/core/contracts.ts`（删除 GoalContinuation* 类型；保留 AgentStatus* / StatusCardTransport）
- `src/storage/sqlite.ts`、`src/storage/memory-thread-store.ts`（删除 goal_continuation 表与 store 方法）
- `src/config/env.ts`、`src/config/federation/config-schema.ts`、`config-authority.ts`、`config/floral.toml`、`.env.example`、`config/catalog/upstream-config-catalog.json`、`tests/config-inventory.test.ts`（删除 goal.continuation）
- `src/service/gateway-commands.ts`（移除 continue/restart 动作）、`src/service/gateway-goals.ts`（移除 continuation 联动）
- `src/service/gateway.ts`、`src/main.ts`（移除 continuation 接线，保留状态卡）
- `src/transport/feishu/feishu-status-card.ts`（移除 cooldown 状态与文案；按钮语义简化）
- `tests/feishu-status-card.test.ts`、`tests/agent-status-card-controller.test.ts`、`tests/gateway-project-chat.test.ts`、`tests/reliability-architecture.test.ts`
- `docs/PHASE10B_GOAL_CONTINUATION_AND_STATUS_CARD.md`、`docs/PHASE10D_GOAL_STATE_AUTHORITY_AND_CONTROLS.md`、`docs/superpowers/specs/2026-08-11-floral-thin-layer-roadmap-design.md`

**新增：**
- `tests/goal-status-adapter.test.ts`（新 facade 的状态卡生命周期 + 控制桥接）

---

### Task 1: 无协调器的 Goal 状态控制与状态卡 facade

**Files:**
- Rewrite: `src/service/gateway-goal-control.ts`（移除 coordinator 依赖，改为纯桥接）
- Rewrite: `src/service/gateway-goal-continuation.ts`
- Test: `tests/goal-status-adapter.test.ts`

**Interfaces:**
- Consumes: `AgentGoalRuntime`（getGoal/setGoal）、`AgentStatusSnapshot`、`StatusCardTransport`、`STATUS_CONTROL_MESSAGE_PREFIX`
- Produces:
  - `GoalStatusControlAction = "pause" | "stop" | "continue" | "restart"`
  - `parseStatusControlAction(text): GoalStatusControlAction | undefined`
  - `handleGoalStatusControl(input): Promise<"paused"|"stopped"|"continued"|"restarted"|"denied"|"busy"|"missing">`
  - `class GoalStatusFacade`（`statusCard`、`onRunStarted/onRunEvent/onRunEnded/onRunFailed/onStopped`、`handleStatusControl/handleContinue/handleRestart`、`statusSnapshot`）

- [ ] **Step 1: 重写 `src/service/gateway-goal-control.ts`**

```ts
import type { AgentGoalRuntime } from "../core/contracts.js";
import { STATUS_CONTROL_MESSAGE_PREFIX } from "../core/contracts.js";
import type { AuditEventInput, ResolvedGatewayIdentity } from "../core/types.js";

export type GoalStatusControlAction = "pause" | "stop" | "continue" | "restart";

export function parseStatusControlAction(
  text: string,
): GoalStatusControlAction | undefined {
  if (!text.startsWith(`${STATUS_CONTROL_MESSAGE_PREFIX} `)) return undefined;
  const action = text.slice(STATUS_CONTROL_MESSAGE_PREFIX.length + 1).trim();
  return action === "pause" || action === "stop" || action === "continue"
    || action === "restart"
    ? action
    : undefined;
}

export interface GoalStatusControlHost {
  agent: AgentGoalRuntime;
  send: (deliveryConversationId: string, text: string) => Promise<void>;
  audit: (event: AuditEventInput) => Promise<void>;
  isConversationBusy: (conversationId: string) => boolean;
  resolveProjectContext: (
    deliveryConversationId: string,
    conversationId: string,
  ) => Promise<{
    threadId: string;
    projectName: string;
    projectCwd: string;
  } | undefined>;
  stopConversation: (conversationId: string) => Promise<unknown>;
}

export type GoalStatusControlOutcome =
  | "paused" | "stopped" | "continued" | "restarted" | "denied" | "busy" | "missing";

export async function handleGoalStatusControl(input: {
  host: GoalStatusControlHost;
  resolved: ResolvedGatewayIdentity;
  deliveryConversationId: string;
  action: GoalStatusControlAction;
}): Promise<GoalStatusControlOutcome> {
  const { host, resolved, deliveryConversationId, action } = input;
  if (resolved.role !== "owner") {
    await host.audit({
      userId: resolved.userId,
      conversationId: resolved.conversationId,
      eventType: "status_control.denied",
      payload: { action },
    });
    await host.send(deliveryConversationId, "只有 owner 可以控制状态卡。");
    return "denied";
  }
  const context = await host.resolveProjectContext(
    deliveryConversationId,
    resolved.conversationId,
  );
  if (action === "pause") {
    await host.stopConversation(resolved.conversationId);
    if (context) {
      await host.agent.setGoal({
        threadId: context.threadId,
        cwd: context.projectCwd,
        status: "paused",
      }).catch(() => undefined);
    }
    await host.send(deliveryConversationId, "已暂停：当前任务已停止，Goal 已置为 paused。");
    return "paused";
  }
  if (action === "stop") {
    await host.stopConversation(resolved.conversationId);
    await host.send(deliveryConversationId, "已停止：当前任务已停止。Goal 状态保持不变。");
    return "stopped";
  }
  if (host.isConversationBusy(resolved.conversationId)) {
    await host.send(deliveryConversationId, "当前任务运行中，不能执行该操作。请先 /stop。");
    return "busy";
  }
  if (!context?.threadId) {
    await host.send(deliveryConversationId, "当前项目还没有 Codex 会话。");
    return "missing";
  }
  await host.agent.setGoal({
    threadId: context.threadId,
    cwd: context.projectCwd,
    status: "active",
  }).catch(() => undefined);
  await host.send(
    deliveryConversationId,
    action === "continue"
      ? "已继续：Goal 已置为 active。"
      : "已重新运行：Goal 已置为 active。",
  );
  return action === "continue" ? "continued" : "restarted";
}
```

- [ ] **Step 2: 重写 `src/service/gateway-goal-continuation.ts` 为 `GoalStatusFacade`**

```ts
import type {
  AgentEvent,
  AgentGoalRuntime,
  AgentRuntime,
  AgentStatusSnapshot,
  ChatTransport,
} from "../core/contracts.js";
import {
  supportsAgentGoals,
  supportsStatusCardTransport,
} from "../core/contracts.js";
import type { AuditEventInput, ResolvedGatewayIdentity } from "../core/types.js";
import { AgentStatusCardController } from "./agent-status-card-controller.js";
import {
  handleGoalStatusControl,
  type GoalStatusControlAction,
  type GoalStatusControlHost,
} from "./gateway-goal-control.js";

export { parseStatusControlAction } from "./gateway-goal-control.js";

export interface GoalStatusFacadeOptions {
  agent: AgentRuntime;
  transport: ChatTransport;
  audit: (event: AuditEventInput) => Promise<void>;
  send: (deliveryConversationId: string, text: string) => Promise<void>;
  isConversationBusy: (conversationId: string) => boolean;
  resolveProjectContext: (
    deliveryConversationId: string,
    conversationId: string,
  ) => Promise<{ threadId: string; projectName: string; projectCwd: string } | undefined>;
  stopConversation: (conversationId: string) => Promise<unknown>;
  statusCard: { enabled: boolean; updateIntervalMs: number; autoPin: boolean };
}

export class GoalStatusFacade {
  readonly statusCard: AgentStatusCardController | undefined;
  readonly #agent: AgentGoalRuntime;
  readonly #options: Omit<GoalStatusFacadeOptions, "statusCard">;

  constructor(options: GoalStatusFacadeOptions) {
    if (!supportsAgentGoals(options.agent)) {
      throw new Error("Goal status facade requires an Agent Goal runtime");
    }
    this.#agent = options.agent;
    this.#options = options;
    this.statusCard = options.statusCard.enabled && supportsStatusCardTransport(options.transport)
      ? new AgentStatusCardController({
          transport: options.transport,
          audit: options.audit,
          enabled: true,
          updateIntervalMs: options.statusCard.updateIntervalMs,
          autoPin: options.statusCard.autoPin,
        })
      : undefined;
  }

  async start(): Promise<void> {
    await this.statusCard?.start().catch(() => undefined);
  }

  async stop(): Promise<void> {
    await this.statusCard?.stop().catch(() => undefined);
  }

  async onRunStarted(
    conversationId: string,
    deliveryConversationId: string,
    projectName: string | undefined,
  ): Promise<void> {
    await this.statusCard?.onRunStarted(
      deliveryConversationId,
      await this.statusSnapshot(conversationId, deliveryConversationId, "running", {
        ...(projectName ? { projectName } : {}),
        lastActivity: "任务开始",
      }),
    ).catch(() => undefined);
  }

  async onRunEvent(deliveryConversationId: string, event: AgentEvent): Promise<void> {
    if (event.type !== "tool.started" && event.type !== "tool.completed") return;
    await this.statusCard?.onRunEvent(deliveryConversationId, {
      state: "running",
      turnNumber: 0,
      elapsedMs: 0,
      lastActivity: event.type === "tool.started"
        ? `正在使用工具 ${event.name}`
        : `工具完成 ${event.name}`,
    }).catch(() => undefined);
  }

  async onRunEnded(
    conversationId: string,
    deliveryConversationId: string,
    projectName: string | undefined,
  ): Promise<void> {
    await this.statusCard?.onRunEnded(
      deliveryConversationId,
      await this.statusSnapshot(conversationId, deliveryConversationId, "idle", {
        ...(projectName ? { projectName } : {}),
      }),
    ).catch(() => undefined);
  }

  async onRunFailed(
    conversationId: string,
    deliveryConversationId: string,
  ): Promise<void> {
    await this.statusCard?.onStopped(
      deliveryConversationId,
      await this.statusSnapshot(conversationId, deliveryConversationId, "stopped"),
    ).catch(() => undefined);
  }

  async onStopped(conversationId: string, deliveryConversationId: string): Promise<void> {
    await this.statusCard?.onStopped(
      deliveryConversationId,
      await this.statusSnapshot(conversationId, deliveryConversationId, "stopped"),
    ).catch(() => undefined);
  }

  async handleStatusControl(
    resolved: ResolvedGatewayIdentity,
    deliveryConversationId: string,
    action: GoalStatusControlAction,
  ): Promise<void> {
    const outcome = await handleGoalStatusControl({
      host: this.#host(),
      resolved,
      deliveryConversationId,
      action,
    });
    if (outcome === "paused" || outcome === "stopped") {
      await this.onStopped(resolved.conversationId, deliveryConversationId);
    }
  }

  async handleContinue(
    resolved: ResolvedGatewayIdentity,
    deliveryConversationId: string,
  ): Promise<void> {
    await handleGoalStatusControl({
      host: this.#host(),
      resolved,
      deliveryConversationId,
      action: "continue",
    });
  }

  async handleRestart(
    resolved: ResolvedGatewayIdentity,
    deliveryConversationId: string,
  ): Promise<void> {
    await handleGoalStatusControl({
      host: this.#host(),
      resolved,
      deliveryConversationId,
      action: "restart",
    });
  }

  async statusSnapshot(
    conversationId: string,
    deliveryConversationId: string,
    state: AgentStatusSnapshot["state"],
    extra: Partial<Pick<
      AgentStatusSnapshot,
      "projectName" | "turnNumber" | "lastActivity" | "goal"
    >> = {},
  ): Promise<AgentStatusSnapshot> {
    const context = await this.#options.resolveProjectContext(
      deliveryConversationId,
      conversationId,
    ).catch(() => undefined);
    const goal = context?.threadId
      ? await this.#agent.getGoal(context.threadId, { cwd: context.projectCwd })
          .catch(() => undefined)
      : undefined;
    return {
      state,
      projectName: extra.projectName ?? context?.projectName,
      turnNumber: extra.turnNumber ?? 0,
      elapsedMs: 0,
      ...(extra.lastActivity ? { lastActivity: extra.lastActivity } : {}),
      ...(goal ? {
        goal: {
          status: goal.status,
          objective: goal.objective,
          tokensUsed: goal.tokensUsed,
          tokenBudget: goal.tokenBudget,
          timeUsedSeconds: goal.timeUsedSeconds,
        },
      } : {}),
    };
  }

  #host(): GoalStatusControlHost {
    return {
      agent: this.#agent,
      send: this.#options.send,
      audit: this.#options.audit,
      isConversationBusy: this.#options.isConversationBusy,
      resolveProjectContext: this.#options.resolveProjectContext,
      stopConversation: this.#options.stopConversation,
    };
  }
}
```

- [ ] **Step 3: 写 facade 测试 `tests/goal-status-adapter.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import type { AgentGoal, AgentGoalRuntime, AgentRuntime } from "../src/core/contracts.js";
import type { AgentRunRequest, AgentRunResult } from "../src/core/types.js";
import { GoalStatusFacade } from "../src/service/gateway-goal-continuation.js";
import { handleGoalStatusControl } from "../src/service/goal-status-control.js";

class FakeGoalAgent implements AgentRuntime, AgentGoalRuntime {
  readonly name = "fake";
  goal: AgentGoal | undefined = {
    threadId: "t", objective: "o", status: "paused",
    tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1,
  };
  async start(): Promise<void> {}
  async run(_r: AgentRunRequest): Promise<AgentRunResult> {
    return { threadId: "t", finalText: "ok" };
  }
  async interrupt(): Promise<void> {}
  async stop(): Promise<void> {}
  async getGoal(): Promise<AgentGoal | undefined> { return this.goal; }
  async setGoal(input: Parameters<AgentGoalRuntime["setGoal"]>[0]): Promise<AgentGoal> {
    if (!this.goal) throw new Error("missing");
    this.goal = { ...this.goal, ...(input.status ? { status: input.status } : {}) };
    return this.goal;
  }
  async clearGoal(): Promise<boolean> { this.goal = undefined; return true; }
}

function host(agent: FakeGoalAgent) {
  return {
    agent,
    send: async () => undefined,
    audit: async () => undefined,
    isConversationBusy: () => false,
    resolveProjectContext: async () => ({ threadId: "t", projectName: "p", projectCwd: "/p" }),
    stopConversation: async () => undefined,
  };
}

describe("GoalStatusFacade", () => {
  it("continues a paused goal by setting it active", async () => {
    const agent = new FakeGoalAgent();
    const outcome = await handleGoalStatusControl({
      host: host(agent),
      resolved: { userId: "u", role: "owner", conversationId: "c" },
      deliveryConversationId: "chat-1",
      action: "continue",
    });
    expect(outcome).toBe("continued");
    expect(agent.goal?.status).toBe("active");
  });

  it("denies non-owner control", async () => {
    const agent = new FakeGoalAgent();
    const outcome = await handleGoalStatusControl({
      host: host(agent),
      resolved: { userId: "u", role: "operator", conversationId: "c" },
      deliveryConversationId: "chat-1",
      action: "stop",
    });
    expect(outcome).toBe("denied");
  });

  it("builds a status snapshot from the native goal", async () => {
    const agent = new FakeGoalAgent();
    const facade = new GoalStatusFacade({
      agent,
      transport: { name: "test", start: async () => undefined, send: async () => undefined, stop: async () => undefined },
      audit: async () => undefined,
      send: async () => undefined,
      isConversationBusy: () => false,
      resolveProjectContext: host(agent).resolveProjectContext,
      stopConversation: async () => undefined,
      statusCard: { enabled: false, updateIntervalMs: 5_000, autoPin: true },
    });
    const snapshot = await facade.statusSnapshot("c", "chat-1", "idle");
    expect(snapshot.goal?.status).toBe("paused");
    expect(snapshot.projectName).toBe("p");
  });
});
```

- [ ] **Step 4: 运行新测试**

Run: `corepack pnpm exec vitest run tests/goal-status-adapter.test.ts`
Expected: PASS（3 个用例）

- [ ] **Step 5: 保持旧文件临时保留，全量测试记录基线**

Run: `corepack pnpm test`
Expected: 全部通过（旧 coordinator 文件仍存在且被旧测试引用；新 facade 尚未被 gateway 使用，类型必须自洽）。

---

### Task 2: 删除 continuation 全套残余

**Files:**
- Delete: `src/service/goal-continuation-coordinator.ts`、`src/service/goal-continuation-support.ts`、`src/service/gateway-goal-control.ts`
- Delete: `tests/goal-continuation-coordinator.test.ts`、`tests/gateway-goal-control.test.ts`
- Modify: `src/core/contracts.ts`（删除 `GoalContinuationRecord`/`GoalContinuationStore`/`supportsGoalContinuationStore`）
- Modify: `src/storage/sqlite.ts`（删除表与 4 个方法；migrate 中加 `DROP TABLE IF EXISTS goal_continuation;`）、`src/storage/memory-thread-store.ts`（删除 4 个方法）

- [ ] **Step 1: 删除五个文件**

Run: `git rm src/service/goal-continuation-coordinator.ts src/service/goal-continuation-support.ts src/service/gateway-goal-control.ts tests/goal-continuation-coordinator.test.ts tests/gateway-goal-control.test.ts`

- [ ] **Step 2: 删除 contracts 中的 continuation 类型**

在 `src/core/contracts.ts` 中删除 `GoalContinuationRecord`、`GoalContinuationStore`、`supportsGoalContinuationStore` 整段（约 364–398 行）。

- [ ] **Step 3: 删除 SQLite goal_continuation**

删除 `src/storage/sqlite.ts` 中 `loadGoalContinuation/saveGoalContinuation/deleteGoalContinuation/listGoalContinuations` 方法、`CREATE TABLE IF NOT EXISTS goal_continuation` 块、`normalizeGoalContinuationRecord/parseGoalContinuationRow/intFlag/finiteNumber` 中仅被 continuation 使用的部分；在 migrate 末尾加：

```sql
DROP TABLE IF EXISTS goal_continuation;
```

同步删除 `src/storage/memory-thread-store.ts` 中的 `#goalContinuations` 与 4 个方法。

- [ ] **Step 4: 运行测试并修复引用**

Run: `corepack pnpm typecheck && corepack pnpm test`
Expected: 通过；若报残留引用，按报错文件删除对应 import/调用（`gateway-goal-continuation.ts` 新 facade 不应再引用 continuation 类型）。

---

### Task 3: 删除 goal.continuation 配置

**Files:**
- Modify: `src/config/env.ts`、`src/config/federation/config-schema.ts`、`config-authority.ts`、`config/floral.toml`、`.env.example`、`config/catalog/upstream-config-catalog.json`、`tests/config-inventory.test.ts`

- [ ] **Step 1: 删除 4 个环境键**

删除 `env.ts` 的 `GOAL_CONTINUATION_ENABLED/COOLDOWN_MS/MAX_TURNS/MAX_WALL_TIME_MS`；删除 `.env.example` 对应 4 行；删除 `config/floral.toml` 的 `[goal.continuation]` 段；删除 `config-schema.ts` 的 `goal` 段（schema/interface/default）；删除 `config-authority.ts` 的 4 个 binding、4 行 status line、`cooldown_ms > 300_000` 校验；删除 catalog JSON 的 4 个 policy 条目。

- [ ] **Step 2: 更新配置清单计数**

`tests/config-inventory.test.ts` 中 `toHaveLength(84)` 改为 `toHaveLength(80)`。

- [ ] **Step 3: 验证**

Run: `corepack pnpm typecheck && corepack pnpm exec vitest run tests/config-inventory.test.ts tests/config-federation.test.ts tests/env-phase3.test.ts`
Expected: PASS

---

### Task 4: 命令收敛

**Files:**
- Modify: `src/service/gateway-commands.ts`（goal 动作去掉 `continue`/`restart`）、`src/service/gateway-goals.ts`（去掉 `continuation` 参数与 `syncCommand` 调用）

- [ ] **Step 1: 移除命令动作**

`gateway-commands.ts`：union 与正则均去掉 `continue|restart`，`/goal continue`、`/goal restart` 不再被解析。

- [ ] **Step 2: 简化 `gateway-goals.ts`**

删除输入中的 `continuation?: GoalContinuationCoordinator`、`syncCommand(...)` 调用块、`continue` 分支（若有）；命令处理只调用 `agent.getGoal/setGoal/clearGoal` 并回复。

- [ ] **Step 3: 更新 gateway 的 goal case**

`src/service/gateway.ts` 的 `case "goal"`：删除 `continue/restart` 分支（约 1492–1499 行）与 `continuation: this.#goalFacade?.coordinator` 传参。

- [ ] **Step 4: 测试**

Run: `corepack pnpm exec vitest run tests/gateway-commands.test.ts tests/gateway-project-chat.test.ts`
Expected: PASS；`gateway-project-chat.test.ts` 中 goal 相关断言若引用旧回复需同步调整。

---

### Task 5: Gateway / main 接线收敛

**Files:**
- Modify: `src/main.ts`、`src/service/gateway.ts`

- [ ] **Step 1: main.ts 去掉 goalContinuation 选项**

删除 `goalContinuation: {...}` 块（约 232–238 行），保留 `statusCard` 块。

- [ ] **Step 2: gateway.ts 改接 `GoalStatusFacade`**

- import 改为 `GoalStatusFacade`（不再 import `GoalContinuationFacade`）；
- 构造条件从 `options.goalContinuation?.enabled` 改为 `options.statusCard?.enabled`，去掉 `goalContinuation` 配置传入，去掉 `runContinuation`；
- 删除 `onRunCompleted` 调用（约 2331 行附近）与 `onUserMessage`（约 424 行）、`stopContinuation`（约 1855 行）；保留 `onRunStarted/onRunEvent/onRunFailed/onStopped/handleStatusControl`；
- 回合结束改为调用 `onRunEnded(conversationId, deliveryConversationId, projectName)`；失败改为调用 `onRunFailed(conversationId, deliveryConversationId)`（去掉 error 实参）；
- `case "goal"` 不再传 `continuation`；
- `#goalFacade` 字段类型改为 `GoalStatusFacade | undefined`。

- [ ] **Step 3: 类型与测试**

Run: `corepack pnpm typecheck && corepack pnpm test`
Expected: 全绿。

---

### Task 6: 状态卡收敛（去掉 cooldown）

**Files:**
- Modify: `src/core/contracts.ts`（`AgentStatusCardState` 去掉 `"cooldown"`）、`src/transport/feishu/feishu-status-card.ts`、`src/service/gateway-goal-continuation.ts`（onRunEvent 等不再用 cooldown）、`tests/feishu-status-card.test.ts`

- [ ] **Step 1: 类型与文案**

`AgentStatusCardState = "idle" | "running" | "stopped"`；卡片 builder 删除 `cooldown` 分支与“下次续跑”文案；`goalStatusLabel` 保留。

- [ ] **Step 2: 测试**

更新 `tests/feishu-status-card.test.ts`：无 cooldown 断言；新增 paused→`["继续","停止"]`、complete→`["重新运行"]` 已有，保留。

- [ ] **Step 3: 验证**

Run: `corepack pnpm exec vitest run tests/feishu-status-card.test.ts tests/agent-status-card-controller.test.ts`
Expected: PASS

---

### Task 7: 预算用例删除与文档

**Files:**
- Modify: `tests/reliability-architecture.test.ts`（删除“keeps orchestration modules inside frozen structure budgets”用例；保留恢复矩阵与 owner 发布边界断言）
- Modify: `docs/PHASE10B_GOAL_CONTINUATION_AND_STATUS_CARD.md`、`docs/PHASE10D_GOAL_STATE_AUTHORITY_AND_CONTROLS.md`、`docs/superpowers/specs/2026-08-11-floral-thin-layer-roadmap-design.md`

- [ ] **Step 1: 删除行数预算用例**

删除 `tests/reliability-architecture.test.ts` 中第一个 `it("keeps orchestration modules inside frozen structure budgets", ...)` 整个用例（budgets 对象与 readFile 断言），保留第二个 `it("freezes the recovery matrix and owner publication boundary", ...)`。

- [ ] **Step 2: 文档**

PHASE10B/10D 标注“自动续跑已移除（Phase 0 方案 B），Goal 由 Codex 原生管理，FLORAL 仅提供飞书显示与命令”；roadmap spec 勾选 Phase 0 完成状态。

- [ ] **Step 3: 全量验证**

Run: `corepack pnpm typecheck && corepack pnpm test && corepack pnpm build && git diff --check`
Expected: 115 文件 / 617−（删除的测试数）个测试全绿；构建通过；diff 无空白错误。

---

### Task 8: 验收与提交

- [ ] **Step 1: 飞书验收清单**

1. `/goal set <目标>` → 卡片立即出现并置顶，显示 Goal 状态/目标/Token 用量。
2. 发送普通消息 → 卡片显示运行中、进度；结束后回到空闲。
3. 卡片“暂停” → 当前任务停止、Goal=paused；卡片显示“继续/停止”。
4. 卡片“继续” → Goal=active；再次手动发消息可继续推进。
5. 卡片“停止” → 当前任务停止、Goal 状态不变。
6. `/goal status|active|complete|clear` 全部正常。
7. 无任何自动续跑回合（等待 >60s 无新回合）。

- [ ] **Step 2: 提交**

由 owner 执行：

```powershell
git add -A
git commit -m "Refactor Goal: remove auto-continuation scheduler, keep native Goal + Feishu status card"
git push
```

```bash
cd /Volumes/WORK_1TB/FLORAL
git pull
corepack pnpm test
corepack pnpm build && corepack pnpm service:restart && corepack pnpm service:status
```
