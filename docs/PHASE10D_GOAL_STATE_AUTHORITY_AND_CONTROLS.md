# Phase 10D — Goal state authority and restart controls

> **Phase 0（2026-08-11）方案 B 更新**：自动续跑已移除；状态控制直接桥接
> 原生 Goal（continue/restart → `setGoal(status=active)`，pause →
> `setGoal(status=paused)` + 中断当前回合），不再经过续跑协调器。

## Why this fix exists

The first Goal reliability pass removed re-entrant `thread/goal/*` RPCs by
using a turn-local projection. A later acceptance test still exposed two
control-plane problems:

1. auto-continuation could stop after the first round because a textual
   `[GOAL_COMPLETE]` marker acted as a second completion authority;
2. the Feishu live card could pause/stop a Goal but offered no direct way to
   continue or restart it.

The failing coordinator tests also exposed an asynchronous scheduler callback
that could not be deterministically awaited by the test harness, and the Goal
facade exceeded its frozen Phase 8G structure budget.

## Frozen authority model

Goal state now has one authority:

```text
Codex native thread Goal
        ↑
floral_goal turn-local projection
        ↑
deferred thread/goal commit after turn terminal
```

`GoalContinuationRecord` is only scheduling state. The Feishu card is only a
UI projection. Free-form assistant text is never Goal state.

A continuation round therefore follows this contract:

- while work remains, leave the native Goal `active`;
- completing one round/substep does **not** complete the Goal;
- when the whole objective is actually complete, call
  `floral_goal/update({status:"complete"})`;
- when genuinely blocked, use `status:"blocked"`;
- `[GOAL_COMPLETE]` and other textual markers have no control meaning.

## Scheduler fixes

The timer callback now returns/awaits the continuation promise instead of
starting `#fire()` through a detached `void` expression. Production timers
remain asynchronous, while deterministic test schedulers can await the same
lifecycle and observe the committed run count/audit state.

The coordinator and facade remain inside the frozen reliability structure
budgets by extracting:

- `goal-continuation-support.ts`
- `gateway-goal-control.ts`

No reliability budget was raised.

## Status-card controls

The owner-facing Feishu card exposes:

```text
running / cooldown
  暂停 | 停止 | 重新开始

paused / stopped-active / idle-active
  继续 | 重新开始

complete
  重新开始
```

`继续` keeps the existing continuation round count and restores the native Goal
to `active` when needed.

`重新开始` is an explicit owner action: it restores the existing native Goal to
`active`, resets FLORAL continuation counters to round 0, and schedules round 1
again. Codex-native accumulated Goal usage fields remain upstream-owned and are
not falsified/reset by FLORAL.

A running Goal may also be explicitly restarted; FLORAL first stops the current
conversation run, then re-arms the Goal from continuation round 1.

`usageLimited` and an already exhausted `budgetLimited` Goal are not blindly
restarted. The owner must first resolve the upstream usage condition or create a
new Goal/budget.

## Command parity

The card controls have command equivalents:

- `/goal continue`
- `/goal restart`

`/goal continue` now means “resume the Goal”, not “enable scheduling but make
the owner separately run `/goal active`”.

## Acceptance target

The canonical two-round test is:

```text
/goal set 自动续跑验收：请分两轮完成——第一轮只回复“第一轮完成”；
第二轮回复“第二轮完成”并在第二轮把 Goal 更新为 complete；
不要在第一轮做完。
```

Expected behavior:

1. card shows round 1, Agent replies `第一轮完成`, native Goal stays `active`;
2. card enters cooldown and schedules round 2;
3. round 2 runs, Agent updates native Goal to `complete` through
   `floral_goal/update`;
4. card ends green as `FLORAL Goal 已完成`;
5. the completed card exposes `重新开始`;
6. pressing `重新开始` resets FLORAL continuation progress and schedules a new
   round 1.
