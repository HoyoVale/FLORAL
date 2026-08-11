import type { AgentStatusSnapshot } from "../../core/contracts.js";

export { STATUS_CONTROL_MESSAGE_PREFIX } from "../../core/contracts.js";

export type FeishuStatusControlAction = "pause" | "stop" | "continue" | "restart";

export interface FeishuStatusControlEvent {
  event_id?: string | undefined;
  create_time?: string | undefined;
  app_id?: string | undefined;
  operator?: {
    open_id?: string | undefined;
  } | undefined;
  action?: {
    tag?: string | undefined;
    value?: unknown;
  } | undefined;
  host?: string | undefined;
  context?: {
    open_message_id?: string | undefined;
    open_chat_id?: string | undefined;
  } | undefined;
}

export interface NormalizedFeishuStatusControl {
  eventId: string;
  appId: string;
  externalUserId: string;
  conversationId: string;
  messageId?: string | undefined;
  action: FeishuStatusControlAction;
  receivedAt: Date;
}

interface FeishuStatusControlValue {
  floral_action: "status_control";
  action: FeishuStatusControlAction;
}

export function buildAgentStatusCard(
  snapshot: AgentStatusSnapshot,
): Record<string, unknown> {
  const title = statusTitle(snapshot);
  const template = statusTemplate(snapshot.state);

  const lines: string[] = [];
  lines.push(`状态：${title}`);
  if (snapshot.turnNumber > 0) {
    lines.push(`轮次：第 ${String(snapshot.turnNumber)} 轮`);
  }
  lines.push(`运行时长：${formatElapsed(snapshot.elapsedMs)}`);
  if (snapshot.projectName) {
    lines.push(`项目：\`${escapeInlineCode(snapshot.projectName)}\``);
  }
  if (snapshot.state === "cooldown" && snapshot.cooldownRemainingMs !== undefined) {
    lines.push(`下次续跑：${formatSeconds(snapshot.cooldownRemainingMs)} 后`);
  }
  if (snapshot.goal) {
    lines.push("");
    lines.push(`**Goal 状态**：${goalStatusLabel(snapshot.goal.status)}`);
    lines.push(`目标：${escapeMarkdown(boundedText(snapshot.goal.objective, 4_000))}`);
    lines.push(
      `Token 用量：${String(snapshot.goal.tokensUsed)} / ${
        snapshot.goal.tokenBudget === null ? "不限" : String(snapshot.goal.tokenBudget)
      }`,
    );
    lines.push(`Goal 已用时：${formatElapsed(snapshot.goal.timeUsedSeconds * 1_000)}`);
  }
  if (snapshot.lastActivity) {
    lines.push("");
    lines.push(`最近进度：${escapeMarkdown(boundedText(snapshot.lastActivity, 160))}`);
  }

  const elements: Array<Record<string, unknown>> = [
    {
      tag: "markdown",
      element_id: "status_text",
      content: lines.join("\n"),
    },
  ];
  const controls = statusControls(snapshot);
  if (controls.length > 0) {
    elements.push({
      tag: "column_set",
      element_id: "status_controls",
      flex_mode: "bisect",
      horizontal_spacing: "8px",
      columns: [
        {
          tag: "column",
          element_id: "control_left_column",
          width: "weighted",
          weight: 1,
          elements: [
            statusButton(
              `${controls[0]!.action}_button`,
              controls[0]!.label,
              controls[0]!.type,
              controls[0]!.action,
            ),
          ],
        },
        ...(controls[1]
          ? [{
              tag: "column",
              element_id: "control_right_column",
              width: "weighted",
              weight: 1,
              elements: [
                statusButton(
                  `${controls[1].action}_button`,
                  controls[1].label,
                  controls[1].type,
                  controls[1].action,
                ),
              ],
            }]
          : []),
      ],
    });
  }

  return {
    schema: "2.0",
    config: {
      update_multi: true,
      enable_forward: false,
    },
    header: {
      template,
      title: {
        tag: "plain_text",
        content: title,
      },
      subtitle: {
        tag: "plain_text",
        content: "FLORAL Agent",
      },
    },
    body: {
      elements,
    },
  };
}

export function normalizeFeishuStatusControlCardAction(
  event: FeishuStatusControlEvent,
  expectedAppId: string,
): NormalizedFeishuStatusControl | undefined {
  const appId = event.app_id?.trim();
  const eventId = event.event_id?.trim();
  const externalUserId = event.operator?.open_id?.trim();
  const conversationId = event.context?.open_chat_id?.trim();
  const messageId = event.context?.open_message_id?.trim();
  const expected = expectedAppId.trim();

  if (
    !expected
    || !appId
    || appId !== expected
    || !eventId
    || !externalUserId
    || !conversationId
    || event.host !== "im_message"
    || event.action?.tag !== "button"
  ) {
    return undefined;
  }

  const value = readStatusControlValue(event.action.value);
  if (!value) return undefined;

  return {
    eventId,
    appId,
    externalUserId,
    conversationId,
    ...(messageId ? { messageId } : {}),
    action: value.action,
    receivedAt: parseCallbackCreateTime(event.create_time),
  };
}

function statusButton(
  elementId: string,
  label: string,
  type: "default" | "danger",
  action: FeishuStatusControlAction,
): Record<string, unknown> {
  const value: FeishuStatusControlValue = {
    floral_action: "status_control",
    action,
  };
  return {
    tag: "button",
    element_id: elementId,
    text: {
      tag: "plain_text",
      content: label,
    },
    type,
    width: "fill",
    behaviors: [
      {
        type: "callback",
        value,
      },
    ],
  };
}

function readStatusControlValue(
  value: unknown,
): FeishuStatusControlValue | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.floral_action !== "status_control") return undefined;
  if (
    record.action !== "pause"
    && record.action !== "stop"
    && record.action !== "continue"
    && record.action !== "restart"
  ) {
    return undefined;
  }
  return {
    floral_action: "status_control",
    action: record.action as FeishuStatusControlAction,
  };
}

function statusControls(snapshot: AgentStatusSnapshot): Array<{
  action: FeishuStatusControlAction;
  label: string;
  type: "default" | "danger";
}> {
  if (snapshot.state === "running" || snapshot.state === "cooldown") {
    return [
      { action: "pause", label: "暂停", type: "default" },
      { action: "stop", label: "停止", type: "danger" },
    ];
  }
  if (snapshot.goal?.status === "complete") {
    return [{ action: "restart", label: "重新运行", type: "default" }];
  }
  if (snapshot.state === "idle" || snapshot.state === "stopped") {
    return [
      { action: "continue", label: "继续", type: "default" },
      { action: "stop", label: "停止", type: "danger" },
    ];
  }
  return [];
}

function statusTitle(snapshot: AgentStatusSnapshot): string {
  if (snapshot.state === "idle" && snapshot.goal?.status === "complete") {
    return "FLORAL Goal 已完成";
  }
  if (snapshot.state === "idle" && snapshot.goal?.status === "paused") {
    return "FLORAL Goal 已暂停";
  }
  switch (snapshot.state) {
    case "running": return "FLORAL Agent 运行中";
    case "cooldown": return "FLORAL Agent 冷却中";
    case "stopped": return "FLORAL Agent 已停止";
    default: return "FLORAL Agent 空闲";
  }
}

function statusTemplate(state: AgentStatusSnapshot["state"]): string {
  switch (state) {
    case "running": return "blue";
    case "cooldown": return "orange";
    case "stopped": return "red";
    default: return "green";
  }
}

function goalStatusLabel(status: string): string {
  switch (status) {
    case "active": return "进行中";
    case "paused": return "已暂停";
    case "blocked": return "已阻塞";
    case "budgetLimited": return "预算受限";
    case "usageLimited": return "用量受限";
    case "complete": return "已完成";
    default: return status;
  }
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${String(hours)} 小时 ${String(minutes)} 分`;
  if (minutes > 0) return `${String(minutes)} 分 ${String(seconds)} 秒`;
  return `${String(seconds)} 秒`;
}

function formatSeconds(ms: number): string {
  return `${String(Math.max(0, Math.ceil(ms / 1_000)))} 秒`;
}

function boundedText(value: string, maxCharacters: number): string {
  const normalized = value
    .replace(/[\u0000-\u001F\u007F]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (normalized.length <= maxCharacters) return normalized;
  return `${normalized.slice(0, Math.max(0, maxCharacters - 3))}...`;
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_{}\[\]()#+\-.!|>~])/gu, "\\$1");
}

function escapeInlineCode(value: string): string {
  return value.replace(/[`\\]/gu, "\\$&");
}

function parseCallbackCreateTime(value: string | undefined): Date {
  if (typeof value === "string" && /^\d{10,17}$/u.test(value)) {
    const numeric = Number(value);
    if (Number.isSafeInteger(numeric)) {
      const millis = value.length >= 16 ? Math.floor(numeric / 1_000) : numeric;
      const parsed = new Date(millis);
      if (Number.isFinite(parsed.getTime())) return parsed;
    }
  }
  return new Date();
}
