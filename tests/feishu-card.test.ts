import { describe, expect, it } from "vitest";
import {
  buildFeishuApprovalCard,
  normalizeFeishuApprovalCardAction,
} from "../src/transport/feishu/feishu-card.js";

describe("Feishu approval cards", () => {
  it("builds a JSON 2.0 card with object-valued callback behaviors", () => {
    const card = buildFeishuApprovalCard({
      conversationId: "oc_chat",
      approvalId: "ABCDEF123456",
      capability: "files.write",
      summary: "write phase5f3-test.txt",
      ttlMs: 60_000,
    }) as {
      schema?: unknown;
      body?: {
        elements?: Array<{
          tag?: unknown;
          columns?: Array<{
            elements?: Array<{
              behaviors?: Array<{ value?: unknown }>;
            }>;
          }>;
        }>;
      };
    };

    expect(card.schema).toBe("2.0");
    const columns = card.body?.elements?.find((element) =>
      element.tag === "column_set"
    )?.columns ?? [];
    expect(columns).toHaveLength(2);

    expect(columns[0]?.elements?.[0]?.behaviors?.[0]?.value).toEqual({
      floral_action: "approval",
      approval_id: "ABCDEF123456",
      decision: "approve",
    });
    expect(columns[1]?.elements?.[0]?.behaviors?.[0]?.value).toEqual({
      floral_action: "approval",
      approval_id: "ABCDEF123456",
      decision: "deny",
    });
  });

  it("normalizes the flattened SDK card.action.trigger payload", () => {
    const result = normalizeFeishuApprovalCardAction({
      event_id: "evt_card",
      create_time: "1786123456789000",
      app_id: "cli_floral",
      operator: { open_id: "ou_owner" },
      host: "im_message",
      context: {
        open_message_id: "om_card",
        open_chat_id: "oc_chat",
      },
      action: {
        tag: "button",
        value: {
          floral_action: "approval",
          approval_id: "abcdef123456",
          decision: "approve",
        },
      },
    }, "cli_floral");

    expect(result).toEqual({
      eventId: "evt_card",
      appId: "cli_floral",
      externalUserId: "ou_owner",
      conversationId: "oc_chat",
      messageId: "om_card",
      approvalId: "ABCDEF123456",
      decision: "approve",
      receivedAt: new Date(1_786_123_456_789),
    });
  });

  it("fails closed for foreign app, scope-less, or malformed callback values", () => {
    const valid = {
      event_id: "evt_card",
      app_id: "cli_floral",
      operator: { open_id: "ou_owner" },
      host: "im_message",
      context: { open_chat_id: "oc_chat" },
      action: {
        tag: "button",
        value: {
          floral_action: "approval",
          approval_id: "ABCDEF123456",
          decision: "deny",
        },
      },
    } as const;

    expect(normalizeFeishuApprovalCardAction(
      valid,
      "cli_other",
    )).toBeUndefined();

    expect(normalizeFeishuApprovalCardAction({
      ...valid,
      operator: {},
    }, "cli_floral")).toBeUndefined();

    expect(normalizeFeishuApprovalCardAction({
      ...valid,
      action: {
        tag: "button",
        value: {
          floral_action: "approval",
          approval_id: "bad",
          decision: "approve",
        },
      },
    }, "cli_floral")).toBeUndefined();

    expect(normalizeFeishuApprovalCardAction({
      ...valid,
      action: {
        tag: "button",
        value: "approve",
      },
    }, "cli_floral")).toBeUndefined();
  });
});
