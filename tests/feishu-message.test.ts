import { describe, expect, it } from "vitest";
import {
  normalizeFeishuMessageEvent,
  type FeishuMessageEvent,
} from "../src/transport/feishu/feishu-message.js";

function event(overrides: Partial<FeishuMessageEvent> = {}): FeishuMessageEvent {
  return {
    sender: {
      sender_type: "user",
      sender_id: { open_id: "ou_owner" },
    },
    message: {
      message_id: "om_message",
      chat_id: "oc_chat",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: "hello" }),
      create_time: "1786123456789",
    },
    ...overrides,
  };
}

describe("normalizeFeishuMessageEvent", () => {
  it("maps a P2P user text event into the FLORAL transport contract", () => {
    const result = normalizeFeishuMessageEvent(event(), "cli_floral");

    expect(result).toEqual({
      id: "om_message",
      identity: {
        transport: "feishu",
        botId: "cli_floral",
        externalUserId: "ou_owner",
        conversationId: "oc_chat",
      },
      text: "hello",
      receivedAt: new Date(1786123456789),
    });
  });

  it("fails closed for group, bot, and non-text events", () => {
    expect(normalizeFeishuMessageEvent(event({
      message: {
        ...event().message!,
        chat_type: "group",
      },
    }), "cli_floral")).toBeUndefined();

    expect(normalizeFeishuMessageEvent(event({
      sender: {
        sender_type: "bot",
        sender_id: { open_id: "ou_bot" },
      },
    }), "cli_floral")).toBeUndefined();

    expect(normalizeFeishuMessageEvent(event({
      message: {
        ...event().message!,
        message_type: "image",
      },
    }), "cli_floral")).toBeUndefined();
  });

  it("fails closed for malformed content or missing identity fields", () => {
    expect(normalizeFeishuMessageEvent(event({
      message: {
        ...event().message!,
        content: "{bad-json",
      },
    }), "cli_floral")).toBeUndefined();

    expect(normalizeFeishuMessageEvent(event({
      sender: {
        sender_type: "user",
        sender_id: {},
      },
    }), "cli_floral")).toBeUndefined();

    expect(normalizeFeishuMessageEvent(event(), "")).toBeUndefined();
  });
});
