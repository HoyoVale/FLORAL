# Phase 10B — Goal auto-continuation and Feishu live status card

> **Phase 0（2026-08-11）方案 B 更新**：Goal 自动续跑调度器已移除（
> `goal-continuation-coordinator` / `goal-continuation-support` /
> `goal_continuation` 表 / `goal.continuation` 配置 / `/goal continue|restart`
> 命令全部删除）。Goal 由 Codex app-server 原生管理，FLORAL 只保留 owner
> 命令、飞书 PATCH 状态卡与卡片控制（暂停/停止/继续/重新开始）的桥接。
> 最小续跑驱动（方案 A）将在后续独立阶段按幂等 + watchdog 要求重新设计。
> 行数预算测试用例已删除（owner 决定），保留恢复矩阵与发布边界断言。

## Summary

Phase 10 finished native Codex thread Goal read/write (`thread/goal/*`). It did
not close the loop that makes a Goal "work on its own": after a turn ended,
FLORAL never checked the Goal again. Phase 10B adds that loop plus a live
Feishu status card so the owner can see at a glance whether the Agent is
running, which turn it is on, how long it has been running, and the Goal state.

## Goal auto-continuation

### Authorization (owner-only)

- `/goal set <objective>` authorizes auto-continuation for that thread.
- `/goal continue` authorizes auto-continuation for an existing Goal that was
  created by the Agent itself (or previously disabled).
- `/goal active` re-arms continuation only when a continuation record already
  exists (Agent-created Goals never auto-continue without an explicit owner
  `/goal continue`).
- `/goal pause|blocked|complete` disables and cancels pending continuation.
- `/goal clear` deletes the continuation record with the native Goal.
- `/stop` and the status-card "停止" button are hard kill switches.
- A new user message supersedes a pending continuation (the user's turn runs
  first; if the Goal is still active and authorized, continuation resumes after
  that turn).

### Loop

1. A turn ends (user message or continuation).
2. Gateway calls the coordinator with the project thread/cwd.
3. Coordinator reads the native Goal (`thread/goal/get`).
4. If `active` and authorized and within limits, it persists `pending` with
   `next_run_at = now + cooldown` and arms a timer (default 30s).
5. When the timer fires it re-checks Goal status, marks the turn started
   (`turn_count += 1`), and calls `agent.run()` on the **same thread** — the
   existing runtime already resumes the thread via `thread/resume` +
   `turn/start`, so no new RPC was needed.
6. The turn's final text is delivered as a normal message, then the loop
   repeats.

Authorizing a Goal (`/goal set`, `/goal continue`, or `/goal active` on an
already-authorized record) **immediately schedules the first continuation** —
no user turn is required to start the loop. This is why `/goal set` alone makes
the Agent start working after the cooldown.

### Limits and safety

- Defaults follow the owner decision: cooldown 30s; max turns, wall time and
  token budget unlimited. All are configurable:
  - `goal.continuation.cooldown_ms`
  - `goal.continuation.max_turns` (0 = unlimited)
  - `goal.continuation.max_wall_time_ms` (0 = unlimited)
  - native Goal `--tokens` budget, enforced by FLORAL: when
    `tokensUsed >= tokenBudget`, the native Goal is set to `budgetLimited` and
    the loop stops.
- The global DeepSeek cost guard still applies to every turn; when the provider
  gate blocks, the run fails and continuation disables itself.
- A failed continuation turn is retried up to 2 times when the failure is
  retryable (for example Codex request timeout). Only after retries are
  exhausted does the loop disable itself and ask the owner to run
  `/goal continue`.
- The continuation prompt always includes the full Goal objective, so the
  model never has to guess what it is working toward.
- Goal dynamic tools use a turn-local projection. Mutations requested by the
  Agent are acknowledged as `commit=pending-after-turn` and FLORAL applies
  native `thread/goal/*` RPC only after `turn/completed`, avoiding re-entrant
  app-server Goal RPC deadlocks.
- Native Goal state is the only completion authority. A continuation round that
  finishes one substep leaves the Goal `active`; when the complete objective is
  genuinely done, the Agent uses `floral_goal/update` with `status=complete`.
  Text markers such as `[GOAL_COMPLETE]` have no control-plane meaning.
- Individual Codex RPC calls are bounded by `codex.request_timeout_ms`
  (default 300s). The turn-completion wait is a separate
  `codex.turn_timeout_ms` / `CODEX_TURN_TIMEOUT_MS` setting, default **2h**.
  `0` remains an explicit debugging escape hatch. The DeepSeek stream idle
  timeout and daily cost guard still apply.
- Pending state is persisted in SQLite (`goal_continuation`). On service
  restart, any pending continuation is **quarantined and disabled**
  (`pending=false`, `enabled=false` + audit `goal.continuation_quarantined`) so
  a restart never silently spawns or leaves an enabled-but-inert zombie loop.
  The owner can inspect state and explicitly `/goal continue` afterward.
- Every schedule/fire/stop/limit event is audited under `goal.continuation_*`.

## Feishu live status card

Feishu has no first-class "typing" API and every card is still a chat message,
so Phase 10B uses:

- **Message-card PATCH** (`PATCH /open-apis/im/v1/messages/:message_id`, SDK
  `client.im.v1.message.patch`) to update one card in place — no CardKit entity
  lifecycle, no `sequence`, no new `cardkit:card:write` scope.
- **Pin** (`client.im.v1.pin.create/delete`) while a run or cooldown is active,
  so the card stays at the top of the chat and is not pushed away by final
  replies. Pin failures are logged and never block the run.

The card shows: state (运行中/冷却中/空闲/已停止), turn number, elapsed time,
project, native Goal status (Chinese labels), the **Goal objective declared
once**, token usage, and the last tool activity. `/goal set` replies with a
short confirmation instead of repeating the objective; `/goal status` remains
the full on-demand view.
While running/cooling down it carries 暂停/停止/重新开始 controls. A paused or
stopped active Goal exposes 继续/重新开始, and a completed Goal exposes 重新开始.
All controls are owner-only and route through the existing card-action channel.
Updates are throttled to `feishu.status_card.update_interval_ms`
(default 5s); failures are audited as `feishu.status_card_failed` and swallowed.
Final answers remain normal messages.

## Configuration

```toml
[feishu.status_card]
enabled = true
update_interval_ms = 5000
auto_pin = true

[goal.continuation]
enabled = true
cooldown_ms = 30000
max_turns = 0
max_wall_time_ms = 0
```

Environment overrides: `FEISHU_STATUS_CARD_*` and `GOAL_CONTINUATION_*`
(documented in `.env.example` and the upstream config catalog).

## Architecture

- `src/service/goal-continuation-coordinator.ts` — timer/limit/store/audit core.
- `src/service/agent-status-card-controller.ts` — card lifecycle, pin, throttle.
- `src/service/gateway-goal-continuation.ts` — thin facade wiring lifecycle
  hooks into Gateway.
- `src/service/gateway-goal-control.ts` — owner Goal pause/stop/continue/restart
  control semantics.
- `src/service/goal-continuation-support.ts` — continuation prompt and pure
  state helpers, keeping the coordinator inside its frozen structure budget.
- `src/transport/feishu/feishu-status-card.ts` — card JSON builder + button
  callback normalization + reserved control text.
- `src/storage/sqlite.ts` / `src/storage/memory-thread-store.ts` —
  `goal_continuation` persistence (schema version 7).

## Verification

- Windows: 115 test files / 606 tests pass, `tsc` build passes,
  `git diff --check` passes.
- New coverage: `tests/goal-continuation-coordinator.test.ts`,
  `tests/agent-status-card-controller.test.ts`,
  `tests/feishu-status-card.test.ts`.
- Feishu acceptance (owner): `/goal set` a small bounded objective → observe
  the pinned status card, at least one auto-continuation after ~30s, final
  replies as normal messages; then verify `/goal pause` and the card "停止"
  button both stop the loop; `/goal clear` removes it.
