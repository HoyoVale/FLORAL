import type {
  AgentAppSummary,
  AgentMcpServerSummary,
  AgentNativeFeatureSummary,
  AgentSkillSummary,
} from "../core/contracts.js";

export interface GatewayStatusSnapshot {
  transport: string;
  agent: string;
  role: string;
  threadActive: boolean;
  runActive: boolean;
  pendingApprovals: number;
  controlMode?: "ask" | "auto" | "full" | undefined;
  remoteModeCeiling?: "auto" | "full" | undefined;
  sandboxMode?: "workspace-write" | "danger-full-access" | undefined;
  approvalPolicy?: "untrusted" | undefined;
  approvalsReviewer?: "user" | "auto_review" | undefined;
  approvalRoute?: "owner" | "auto-review" | "full-auto-codex-native" | undefined;
  selectedProject?: string | undefined;
  workspaceEnabled?: boolean | undefined;
  runtimeLines: string[];
}

export function formatGatewayStatus(
  snapshot: GatewayStatusSnapshot,
  debug: boolean,
): string {
  if (debug) {
    return [
      "FLORAL 状态（诊断）",
      `transport=${snapshot.transport}`,
      `agent=${snapshot.agent}`,
      `role=${snapshot.role}`,
      `thread=${snapshot.threadActive ? "active" : "none"}`,
      `run=${snapshot.runActive ? "active" : "idle"}`,
      `mode=${snapshot.controlMode ?? "ask"}`,
      `mode_ceiling=${snapshot.remoteModeCeiling ?? "auto"}`,
      `requested_sandbox=${snapshot.sandboxMode ?? "workspace-write"}`,
      `requested_approval_policy=${snapshot.approvalPolicy ?? "untrusted"}`,
      `requested_reviewer=${snapshot.approvalsReviewer ?? "user"}`,
      `approval_route=${snapshot.approvalRoute ?? "owner"}`,
      `workspace=${snapshot.workspaceEnabled === true ? "enabled" : "legacy"}`,
      `project=${snapshot.selectedProject ?? "none"}`,
      `approvals_pending=${String(snapshot.pendingApprovals)}`,
      ...snapshot.runtimeLines,
    ].join("\n");
  }

  const values = parseRuntimeStatusLines(snapshot.runtimeLines);
  const lines = [
    "FLORAL 正常运行",
    "",
    `状态：${snapshot.runActive ? "正在处理" : "空闲"}`,
    `会话：${snapshot.threadActive ? "已建立" : "未建立"}`,
    `执行模式：${humanizeControlMode(snapshot.controlMode ?? "ask")}`,
    `权限上限：${snapshot.remoteModeCeiling ?? "auto"}`,
    ...(snapshot.workspaceEnabled === true
      ? [`项目：${snapshot.selectedProject ?? "未选择"}`]
      : []),
    `待审批：${String(snapshot.pendingApprovals)}`,
  ];

  const costGuard = values.get("cost_guard");
  if (costGuard) {
    lines.push(`成本守卫：${humanizeCostGuard(costGuard)}`);
  }

  const cost24h = values.get("cost_24h");
  if (cost24h) {
    lines.push(`今日成本：${humanizeCost(cost24h)}`);
  }

  return lines.join("\n");
}

export function formatNativeMemoryStatus(runtimeLines: string[]): string {
  const values = parseRuntimeStatusLines(runtimeLines);
  const state = values.get("codex_memory") ?? "unknown";
  const lifecycle = values.get("codex_memory_lifecycle") ?? "unknown";
  const scope = values.get("codex_memory_scope") ?? "unknown";
  const activeConfig = values.get("codex_memory_active_config") ?? "unknown";
  const runtimeConfig = values.get("codex_memory_runtime_config") ?? "unknown";
  const use = values.get("codex_memory_use") ?? "unknown";
  const generate = values.get("codex_memory_generate") ?? "unknown";
  const storage = values.get("codex_memory_storage") ?? "unknown";
  const index = values.get("codex_memory_index") ?? "unknown";
  const summary = values.get("codex_memory_summary") ?? "unknown";
  const summarySchema = values.get("codex_memory_summary_schema") ?? "unknown";
  const raw = values.get("codex_memory_raw") ?? "unknown";
  const summaries = values.get("codex_memory_rollout_summaries") ?? "unknown";
  const lastArtifactAt = values.get("codex_memory_last_artifact_at") ?? "none";

  return [
    "Codex Native Memory",
    `state=${state}`,
    `lifecycle=${lifecycle}`,
    `scope=${scope}`,
    `active_config=${activeConfig}`,
    `runtime_config=${runtimeConfig}`,
    `use=${use}`,
    `generate=${generate}`,
    `storage=${storage}`,
    `memory_index=${index}`,
    `memory_summary=${summary}`,
    `memory_summary_schema=${summarySchema}`,
    `raw_memories=${raw}`,
    `rollout_summaries=${summaries}`,
    `last_artifact_at=${lastArtifactAt}`,
    "说明：armed=已启用但尚无生成产物；generated=已有提取/未通过校验的产物；consolidated=MEMORY.md 与 v1 memory_summary.md 均通过 Codex 原生结构校验。",
    "该状态只观察 Codex 生成元数据，不读取或修改记忆正文。",
  ].join("\n");
}

export function formatNativeMemoryDiagnostics(runtimeLines: string[]): string {
  const values = parseRuntimeStatusLines(runtimeLines);
  return [
    "Codex Native Memory Phase 2 Diagnostics",
    `lifecycle=${values.get("codex_memory_lifecycle") ?? "unknown"}`,
    `database=${values.get("codex_memory_phase2_database") ?? "unknown"}`,
    `database_file=${values.get("codex_memory_phase2_database_file") ?? "none"}`,
    `stage1_outputs=${values.get("codex_memory_stage1_outputs") ?? "unknown"}`,
    `stage1_selected_for_phase2=${values.get("codex_memory_stage1_selected_for_phase2") ?? "unknown"}`,
    `stage1_jobs_done=${values.get("codex_memory_stage1_jobs_done") ?? "unknown"}`,
    `stage1_jobs_error=${values.get("codex_memory_stage1_jobs_error") ?? "unknown"}`,
    `phase2_job=${values.get("codex_memory_phase2_job") ?? "unknown"}`,
    `phase2_status=${values.get("codex_memory_phase2_status") ?? "unknown"}`,
    `phase2_retry_remaining=${values.get("codex_memory_phase2_retry_remaining") ?? "unknown"}`,
    `phase2_error_class=${values.get("codex_memory_phase2_error_class") ?? "unknown"}`,
    `phase2_workspace_diff=${values.get("codex_memory_phase2_workspace_diff") ?? "unknown"}`,
    `memory_git_baseline=${values.get("codex_memory_phase2_git_baseline") ?? "unknown"}`,
    `memory_index=${values.get("codex_memory_index") ?? "unknown"}`,
    `memory_summary=${values.get("codex_memory_summary") ?? "unknown"}`,
    `memory_summary_schema=${values.get("codex_memory_summary_schema") ?? "unknown"}`,
    `artifact_contract=${values.get("codex_memory_artifact_contract") ?? "unknown"}`,
    `diagnosis=${values.get("codex_memory_phase2_diagnosis") ?? "unknown"}`,
    "说明：只读检查 Codex-owned SQLite job 元数据与 memory workspace 元数据；不读取记忆正文，不修改数据库。",
  ].join("\n");
}

export function formatAgentSkills(skills: AgentSkillSummary[]): string {
  if (skills.length === 0) {
    return [
      "Codex Skills",
      "当前工作目录没有发现可用 Skill。",
    ].join("\n");
  }

  const enabled = skills.filter((skill) => skill.enabled);
  const disabled = skills.filter((skill) => !skill.enabled);
  const lines = ["Codex Skills", ""];
  enabled.forEach((skill, index) => {
    lines.push(
      `${String(index + 1)}. $${skill.name} [${skill.scope}]`,
      `   ${skill.description}`,
    );
  });
  if (disabled.length > 0) {
    lines.push("", `已禁用：${disabled.map((skill) => `$${skill.name}`).join(", ")}`);
  }
  lines.push("", "可直接描述任务让 Codex 自动选择 Skill，也可以显式使用 $skill-name。 ");
  return lines.join("\n").trimEnd();
}

export function formatAgentApps(
  apps: AgentAppSummary[],
  availableApps: AgentAppSummary[] = [],
): string {
  const runtimeApps = apps.filter((app) => app.source === "installed-runtime");
  const directoryFallbackApps = apps.filter((app) => app.source === "directory-fallback");
  const callableKnown = runtimeApps.filter((app) => app.callable !== undefined);
  const lines = [
    "Codex Apps",
    `已安装运行态：${String(runtimeApps.length)}；可调用（已知）：${String(callableKnown.filter((app) => app.callable === true).length)}/${String(callableKnown.length)}`,
    `目录可见：${String(availableApps.length)}；可访问：${String(availableApps.filter((app) => app.accessible === true).length)}`,
  ];
  if (runtimeApps.length === 0) {
    lines.push("", "当前 Codex runtime 没有报告已安装 App。 ");
  } else {
    lines.push("", "已安装 / 运行态");
    runtimeApps.slice(0, 100).forEach((app, index) => {
      lines.push(
        `${String(index + 1)}. ${app.runtimeName ?? app.id}`,
        [
          `   id=${app.id}`,
          `enabled=${String(app.enabled)}`,
          `callable=${app.callable === undefined ? "unknown" : String(app.callable)}`,
          `source=${app.source}`,
          ...(app.accessible !== undefined ? [`accessible=${String(app.accessible)}`] : []),
        ].join(" "),
      );
    });
  }
  if (directoryFallbackApps.length > 0) {
    lines.push(
      "",
      `运行态接口不可用：app/list fallback 返回 ${String(directoryFallbackApps.length)} 个目录项；这些条目只用于发现，不视为已安装或可调用证据。`,
    );
  }
  if (availableApps.length > 0) {
    lines.push("", "App 目录（安装/连接候选）");
    availableApps.slice(0, 30).forEach((app, index) => {
      lines.push(
        `${String(index + 1)}. ${app.runtimeName ?? app.id}`,
        [
          `   id=${app.id}`,
          `accessible=${String(app.accessible === true)}`,
          `enabled=${String(app.enabled)}`,
          `install=${app.installUrl ? "supported-handoff" : "unavailable"}`,
        ].join(" "),
        ...(app.description ? [`   ${app.description}`] : []),
      );
    });
    lines.push(
      "",
      "需要安装/连接 App 时，Agent 应使用 floral_extensions/prepare_app_install 获取受支持安装入口；认证由用户在受支持界面完成。 ",
    );
  }
  lines.push(
    "",
    "source=directory-fallback 表示当前 App Server 不支持 app/installed；此时 callable=unknown，不把目录可见误报成实际可调用。",
  );
  return lines.join("\n").trimEnd();
}

export function formatAgentMcpServers(servers: AgentMcpServerSummary[]): string {
  const ready = servers.filter((server) => server.status === "ready");
  const lines = [
    "Codex MCP",
    `配置：${String(servers.length)}；ready：${String(ready.length)}`,
  ];
  if (servers.length === 0) {
    lines.push("", "当前 Codex runtime 没有报告 MCP server。 ");
    return lines.join("\n").trimEnd();
  }
  lines.push("");
  servers.slice(0, 100).forEach((server, index) => {
    lines.push(
      `${String(index + 1)}. ${server.name}`,
      [
        `   status=${server.status}`,
        `tools=${String(server.tools.length)}`,
        ...(server.authStatus ? [`auth=${server.authStatus}`] : []),
        ...(server.failureReason ? [`failure=${server.failureReason}`] : []),
      ].join(" "),
    );
  });
  lines.push("", "status=ready 表示 App Server 明确报告 ready，或当前 status/list 已返回非空工具集；明确 failed/cancelled/starting 状态仍优先。 ");
  return lines.join("\n").trimEnd();
}

export function formatNativePluginStatus(
  features: AgentNativeFeatureSummary[],
): string {
  const byName = new Map(features.map((feature) => [feature.name, feature]));
  const plugins = byName.get("plugins");
  const apps = byName.get("apps");
  const line = (name: string, feature: AgentNativeFeatureSummary | undefined) =>
    feature
      ? `${name}: stage=${feature.stage} enabled=${String(feature.enabled)} default=${String(feature.defaultEnabled)}`
      : `${name}: stage=unknown enabled=unknown default=unknown`;
  return [
    "Codex Native Extensions",
    line("plugins", plugins),
    line("apps", apps),
    "",
    "Apps：FLORAL 使用 app/installed；本机接口不兼容时回退 app/list，并把 callable 明确标为 unknown。可用 App 可通过原生 app:// mention 调用。",
    "MCP：FLORAL 使用 mcpServerStatus/list 验证真实启动/工具状态，并通过受控 External MCP Registry + config/mcpServer/reload 管理批准后的 GitHub/Browser MCP。",
    "Plugins：Codex CLI 的 /plugins 是当前正式安装面；App Server 的 plugin/list/read/install/uninstall 仍被上游标记为 under development，因此 FLORAL 生产 Agent 不调用这些写接口。",
  ].join("\n");
}

export function gatewayHelpText(): string {
  return [
    "FLORAL",
    "",
    "直接发送消息即可开始对话。",
    "",
    "/new      开始新会话",
    "/status   查看运行状态",
    "/skills   查看当前 Codex Skill",
    "/apps     查看当前 Codex App（兼容 app/list fallback）",
    "/plugins  查看 Codex Plugin 功能状态与 FLORAL 接入成熟度",
    "/mcp      查看当前 Codex MCP server 启动/认证/工具状态",
    "/system   查看 FLORAL 只读系统地图",
    "/system <component> 查看组件所有权、状态与证据",
    "/diagnose 查看证据驱动的只读系统诊断",
    "/diagnose <component> 诊断单个组件并给出只读检查顺序",
    "/maintenance 查看维护自治模式与机器 ceiling",
    "/maintenance manual|owner-auto|self-heal 切换维护自治模式（owner，不能超过机器 ceiling）",
    "/maintenance reset-breaker 重置 Self-Heal circuit breaker（owner）",
    "/memory   查看 Codex Native Memory 生命周期",
    "/memory diagnose 只读诊断 Native Memory Phase 2（owner）",
    "/projects 列出 Workspace Root 下的项目",
    "/project  查看当前项目",
    "/project <name> 切换项目",
    "/project new <name> 创建项目并初始化共享上下文（owner）",
    "/project context 查看当前项目共享上下文状态",
    "/project context init 初始化 AGENTS.md + .floral 共享上下文（owner）",
    "/project memory 查看显式项目长期记忆统计",
    "/project remember context <内容> 记录稳定项目事实（owner）",
    "/project remember decision <内容> 记录持久决策（owner）",
    "/project remember issue <内容> 记录活跃已知问题（owner）",
    "/chats    列出当前项目的 Codex 会话",
    "/chat <序号> 切换到列表中的会话",
    "/chat new 在当前项目开始新会话",
    "/chat archive <序号> 归档列表中的 Codex 会话（owner）",
    "/mode     查看执行模式",
    "/mode ask 使用 Codex 原生审批 + 飞书确认",
    "/mode auto 使用 Codex auto_review（owner）",
    "/mode full 请求 Codex full 执行；项目 named permission profile 仍保持项目隔离（owner）",
    "/stop     停止当前任务",
    "/help     查看帮助",
    "",
    "需要审批时，FLORAL 会单独提示。",
  ].join("\n");
}

function humanizeControlMode(mode: "ask" | "auto" | "full"): string {
  if (mode === "full") return "完全权限";
  if (mode === "auto") return "自动审查";
  return "询问";
}

function parseRuntimeStatusLines(lines: string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of lines) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key && value) values.set(key, value);
  }
  return values;
}

function humanizeCostGuard(value: string): string {
  if (value === "ready") return "正常";
  if (value.startsWith("blocked")) return "已限制请求";
  return "需要检查";
}

function humanizeCost(value: string): string {
  const slash = value.indexOf("/");
  if (slash < 0) return value;
  const used = value.slice(0, slash).trim();
  const limit = value.slice(slash + 1).trim();
  if (!used || !limit) return value;
  const normalizedLimit = limit.startsWith("¥") ? limit : `¥${limit}`;
  return `${used} / ${normalizedLimit}`;
}
