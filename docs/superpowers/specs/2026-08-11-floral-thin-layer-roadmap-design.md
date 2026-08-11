# FLORAL 薄层收敛路线图（设计文档）

日期：2026-08-11

## 1. 目标与原则

FLORAL 的目标是：基于 Codex app-server 的一层**薄调度层**，最大化利用 Codex
原生能力，以飞书作为聊天端。

原则：

1. **Codex app-server 是唯一的 Agent 执行权威**。Goal、memory、thread、
   skills、tools、MCP、plugins、apps、approvals 等能力，凡 Codex 原生已有，
   FLORAL 只做桥接、授权、展示，不重复实现状态机。
2. **FLORAL 只持有**：聊天身份与 owner 角色、策略/审批的桥接、可靠投递、
   会话↔项目↔线程映射、飞书展示（含 PATCH 状态卡）。
3. **DeepSeek 自定义 provider bridge 是唯一例外大块**：保留，但固化为独立
   边界，不向其中塞调度逻辑。
4. **飞书是唯一生产 transport**：QQ 兼容层移除。
5. **跑稳再删**：先修稳核心链路，再逐块归档外围，不做大爆炸式删除。
6. **能力对齐 Codex 桌面端**：skills/tools/MCP/plugins/apps 的期望是“像
   桌面端一样正常使用”，依赖 Codex 自身实现。

## 2. 现状摘要

- `src` 约 170+ TS 文件；115 个测试文件 / 617 个测试；40+ 份 Phase 文档。
- 最大非薄块：DeepSeek bridge 与 managed runtime（约 3000 行）、配置联邦/
  迁移/渲染/诊断机器（约 4000 行）、Goal 续跑调度器（约 1000 行）、系统
  自感知/自维护（约 2500 行）、QQ transport（880 行）。
- 当前权限机制分层过多（authorization authority、approval broker、本地确认、
  远程审批、会话级授权等），未最大化利用 Codex app-server 原生权限/审批线。

## 3. 收敛路线图

### Phase 0 — Goal 重构（当前重点）

目标：native Goal 归 Codex；FLORAL 只做飞书适配（PATCH 状态卡、owner 命令、
状态透出）。移除自建的 `[GOAL_COMPLETE]` 第二状态机；续跑调度要么最小化重建
（幂等 + stall watchdog），要么暂时移除只做状态展示。

详见第 5 节 Goal 重构设计。

**状态（2026-08-11）**：方案 B 已实施——自动续跑调度器、`goal_continuation`
持久化、`goal.continuation` 配置、`/goal continue|restart` 命令全部移除；
状态控制直接桥接原生 Goal；行数预算用例按 owner 决定删除。方案 A（最小续跑
驱动 + 幂等 + watchdog）留待后续独立阶段。

### Phase 1 — 薄层边界与权限简化

- 固化边界文档：FLORAL 持有 身份/策略桥接/投递/映射/展示；DeepSeek bridge
  为唯一例外。
- 权限机制重构：最大化使用 Codex app-server 原生权限/审批线，移除 FLORAL
  自建的多层审批状态机中可被原生能力替代的部分（保留 owner 角色与飞书审批
  桥接所需的必要层）。
- gateway 与 bridge 的接口固定为稳定契约。

### Phase 2 — 能力对齐桌面端

- skills/tools/MCP/plugins/apps 全部走 Codex 原生发现与执行，FLORAL 只保留
  受控安装/审批桥接与状态展示。
- 移除或归档 FLORAL 侧重复的影子实现（如 extension 影子账本中可被原生
  readback 替代的部分）。

### Phase 3 — 移除 QQ

- 归档 `src/transport/qq`、QQ policy/approval broker、QQ 配置与测试。
- 飞书成为唯一生产 transport；mock transport 保留给 Windows 开发测试。

### Phase 4 — 精简外围

- 配置联邦/迁移/渲染/诊断机器收敛为“启动校验 + 渲染最小必要配置”。
- 系统自感知/自维护/记忆诊断等降为观察/归档，不阻塞主链路。

### Phase 5 — 长期移交

- Codex app-server 能力成熟一项，FLORAL 移交一项（goal 续跑、compaction、
  原生记忆等）。

## 4. 验收标准（总）

- 飞书端可正常完成：消息收发、owner 身份、审批、Goal 状态展示、能力使用。
- 测试全绿（115 文件 / 617+ 测试）。
- 结构预算护栏持续生效。
- 删除项有归档分支（git tag/branch），可回退。

## 5. Goal 重构设计（初稿）

### 5.1 原则

- **native Goal 是唯一状态权威**（`thread/goal/*`）。
- **Agent 通过 Codex 原生 goal 工具**（`get_goal` / `create_goal` /
  `update_goal`）管理目标，FLORAL 不拦截、不覆盖。
- **FLORAL 只做飞书适配**：
  - owner 命令：`/goal set|status|active|pause|complete|clear`；
  - PATCH 状态卡实时显示 Goal 状态（这是飞书唯一可实时更新的方式）；
  - 卡片控制：暂停/停止/继续/重新运行（owner-only，桥接到原生 Goal）。
- **移除** `[GOAL_COMPLETE]` 标记、turn-local projection 之外的影子状态机
  语义（deferred mutation 若与原生工具冲突则一并收敛）。

### 5.2 自动续跑（待确认）

方案 A（推荐）：**保留最小续跑驱动**——只做“回合结束 → 查原生 Goal →
active 则冷却后开下一回合”，不维护任何完成语义；幂等用 durable journal
correlation id，加基于心跳的 stall watchdog。工作量最大但保留“设 goal 自动
干活”。

方案 B：**暂时移除自动续跑**——只做状态展示与命令，Goal 由 owner 或 Codex
原生机制推进；稳定后再按方案 A 加回。工作量最小，最符合“跑稳再删”。

### 5.3 组件边界（重构后）

- `codex-goals.ts` / `codex-app-server.ts`：native goal RPC 透出（保留）。
- `gateway-goals.ts`：owner 命令（保留，简化）。
- `feishu-status-card.ts` + `agent-status-card-controller.ts`：飞书 PATCH
  状态卡（保留，这是核心价值）。
- `goal-continuation-coordinator.ts` / `gateway-goal-continuation.ts` /
  `goal-status-control.ts`：按 5.2 方案收敛（A：最小驱动；B：移除驱动、
  仅保留卡片/命令桥接）。
- `goal_continuation` SQLite 表：方案 B 下删除；方案 A 下保留但只存调度
  状态（幂等键、冷却、轮次），不存完成语义。

## 6. 风险与回退

- Goal 重构期间自动续跑可能暂时不可用（方案 B）或仍偶发卡死（方案 A 未
  完成 watchdog 前）。
- 权限简化以“跑稳”为前提，逐步替换，不一次性重写。
- 每个删除项先归档分支，可回退。

## 7. 下一步

1. 用户确认第 5 节 Goal 重构设计（尤其 5.2 方案 A/B）。
2. 调用 writing-plans 技能产出实施计划。
3. 按 Phase 0 → 5 执行。
