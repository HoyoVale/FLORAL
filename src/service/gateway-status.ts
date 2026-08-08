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
      `sandbox=${snapshot.sandboxMode ?? "workspace-write"}`,
      `approval_policy=${snapshot.approvalPolicy ?? "untrusted"}`,
      `reviewer=${snapshot.approvalsReviewer ?? "user"}`,
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

export function gatewayHelpText(): string {
  return [
    "FLORAL",
    "",
    "直接发送消息即可开始对话。",
    "",
    "/new      开始新会话",
    "/status   查看运行状态",
    "/projects 列出 Workspace Root 下的项目",
    "/project  查看当前项目",
    "/project <name> 切换项目",
    "/chats    列出当前项目的 Codex 会话",
    "/chat <序号> 切换到列表中的会话",
    "/chat new 在当前项目开始新会话",
    "/mode     查看执行模式",
    "/mode ask 使用 Codex 原生审批 + 飞书确认",
    "/mode auto 使用 Codex auto_review（owner）",
    "/mode full 使用本机预授权的 Codex danger-full-access（owner）",
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
