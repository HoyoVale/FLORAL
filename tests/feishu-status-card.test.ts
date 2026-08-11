import { describe, expect, it } from "vitest";
import { parseStatusControlAction } from "../src/service/gateway-goal-continuation.js";
import {
  buildAgentStatusCard,
  normalizeFeishuStatusControlCardAction,
} from "../src/transport/feishu/feishu-status-card.js";

describe("agent status card", () => {
  it("builds a schema 2.0 shared card with status fields and pause/stop buttons", () => {
    const card = buildAgentStatusCard({
      state: "running",
      turnNumber: 3,
      elapsedMs: 12_000,
      projectName: "FLORAL",
      lastActivity: "正在使用工具 shell",
      goal: {
        status: "active",
        objective: "完成 Phase 10B",
        tokensUsed: 42,
        tokenBudget: null,
        timeUsedSeconds: 30,
      },
    }) as Record<string, unknown>;

    expect(card.schema).toBe("2.0");
    expect((card.config as Record<string, unknown>).update_multi).toBe(true);
    const header = card.header as Record<string, unknown>;
    expect((header.title as Record<string, unknown>).content).toBe("FLORAL Agent 运行中");
    const elements = (card.body as Record<string, unknown>).elements as Array<Record<string, unknown>>;
    const markdown = elements[0] as Record<string, unknown>;
    expect(String(markdown.content)).toContain("第 3 轮");
    expect(String(markdown.content)).toContain("**Goal 状态**：进行中");
    expect(String(markdown.content)).toContain("目标：完成 Phase 10B");
    expect(String(markdown.content)).toContain("Token 用量：42 / 不限");
    expect(String(markdown.content)).toContain("Goal 已用时：30 秒");
    expect(String(markdown.content)).toContain("FLORAL");
    const controls = elements[1] as Record<string, unknown>;
    const columns = controls.columns as Array<Record<string, unknown>>;
    const buttons = columns.flatMap((column) =>
      (column.elements as Array<Record<string, unknown>>));
    expect(buttons.map((button) => (button.text as Record<string, unknown>).content))
      .toEqual(["暂停", "停止", "重新开始"]);
  });

  it("offers a restart control after Goal completion", () => {
    const card = buildAgentStatusCard({
      state: "idle",
      turnNumber: 2,
      elapsedMs: 20_000,
      goal: {
        status: "complete",
        objective: "done",
        tokensUsed: 10,
        tokenBudget: null,
        timeUsedSeconds: 5,
      },
    }) as Record<string, unknown>;
    const elements = (card.body as Record<string, unknown>).elements as Array<Record<string, unknown>>;
    expect((((card.header as Record<string, unknown>).title as Record<string, unknown>).content))
      .toBe("FLORAL Goal 已完成");
    expect(elements).toHaveLength(2);
    expect(String(elements[0]?.content)).toContain("已完成");
    const controls = elements[1] as Record<string, unknown>;
    const columns = controls.columns as Array<Record<string, unknown>>;
    const buttons = columns.flatMap((column) =>
      (column.elements as Array<Record<string, unknown>>));
    expect(buttons.map((button) => (button.text as Record<string, unknown>).content))
      .toEqual(["重新开始"]);
  });

  it("offers continue and restart controls for a paused Goal", () => {
    const card = buildAgentStatusCard({
      state: "idle",
      turnNumber: 2,
      elapsedMs: 20_000,
      goal: {
        status: "paused",
        objective: "paused goal",
        tokensUsed: 10,
        tokenBudget: null,
        timeUsedSeconds: 5,
      },
    }) as Record<string, unknown>;
    const elements = (card.body as Record<string, unknown>).elements as Array<Record<string, unknown>>;
    const controls = elements[1] as Record<string, unknown>;
    const columns = controls.columns as Array<Record<string, unknown>>;
    const buttons = columns.flatMap((column) =>
      (column.elements as Array<Record<string, unknown>>));
    expect(buttons.map((button) => (button.text as Record<string, unknown>).content))
      .toEqual(["继续", "重新开始"]);
  });

  it("normalizes a valid status-control callback and rejects unknown values", () => {
    const event = {
      event_id: "evt-1",
      create_time: "1710000000000",
      app_id: "cli_floral",
      operator: { open_id: "ou_1" },
      action: {
        tag: "button",
        value: { floral_action: "status_control", action: "stop" },
      },
      host: "im_message",
      context: {
        open_message_id: "om_1",
        open_chat_id: "oc_1",
      },
    };
    const normalized = normalizeFeishuStatusControlCardAction(event, "cli_floral");
    expect(normalized?.action).toBe("stop");
    expect(normalized?.conversationId).toBe("oc_1");
    const restart = normalizeFeishuStatusControlCardAction(
      {
        ...event,
        action: {
          tag: "button",
          value: { floral_action: "status_control", action: "restart" },
        },
      },
      "cli_floral",
    );
    expect(restart?.action).toBe("restart");

    const unknown = normalizeFeishuStatusControlCardAction(
      { ...event, action: { tag: "button", value: { floral_action: "approval" } } },
      "cli_floral",
    );
    expect(unknown).toBeUndefined();
  });

  it("parses the reserved status-control message text", () => {
    expect(parseStatusControlAction("__floral_status_control__ pause")).toBe("pause");
    expect(parseStatusControlAction("__floral_status_control__ stop")).toBe("stop");
    expect(parseStatusControlAction("__floral_status_control__ continue")).toBe("continue");
    expect(parseStatusControlAction("__floral_status_control__ restart")).toBe("restart");
    expect(parseStatusControlAction("__floral_status_control__ unknown")).toBeUndefined();
    expect(parseStatusControlAction("hello")).toBeUndefined();
  });
});
