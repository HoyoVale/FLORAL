import { describe, expect, it } from "vitest";
import { normalizeFeishuMessageEvent, type FeishuMessageEvent } from "../src/transport/feishu/feishu-message.js";

function event(overrides: Partial<FeishuMessageEvent> = {}): FeishuMessageEvent {
  return {
    sender: { sender_type: "user", sender_id: { open_id: "ou_owner" } },
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
  it("maps P2P text", () => {
    expect(normalizeFeishuMessageEvent(event(), "cli_floral")?.text).toBe("hello");
  });

  it("keeps image and file resources as remote refs", () => {
    const image = normalizeFeishuMessageEvent(event({
      message: { ...event().message!, message_type: "image", content: JSON.stringify({ image_key: "img_owner" }) },
    }), "cli_floral");
    expect(image?.text).toBe("");
    expect(image?.attachments?.[0]).toEqual({
      id: "image:img_owner",
      kind: "image",
      source: { transport: "feishu", messageId: "om_message", resourceKey: "img_owner" },
    });

    const file = normalizeFeishuMessageEvent(event({
      message: { ...event().message!, message_type: "file", content: JSON.stringify({ file_key: "file_owner", file_name: "report.pdf" }) },
    }), "cli_floral");
    expect(file?.attachments?.[0]?.fileName).toBe("report.pdf");
  });

  it("extracts post text and embedded images", () => {
    const post = normalizeFeishuMessageEvent(event({
      message: {
        ...event().message!,
        message_type: "post",
        content: JSON.stringify({ zh_cn: { title: "Report", content: [[{ tag: "text", text: "see screenshot" }], [{ tag: "img", image_key: "img_post" }]] } }),
      },
    }), "cli_floral");
    expect(post?.text).toBe("Report\nsee screenshot");
    expect(post?.attachments?.[0]?.source.resourceKey).toBe("img_post");
  });

  it("fails closed for group, bot, unsupported media, and malformed payloads", () => {
    expect(normalizeFeishuMessageEvent(event({ message: { ...event().message!, chat_type: "group" } }), "cli_floral")).toBeUndefined();
    expect(normalizeFeishuMessageEvent(event({ sender: { sender_type: "bot", sender_id: { open_id: "ou_bot" } } }), "cli_floral")).toBeUndefined();
    expect(normalizeFeishuMessageEvent(event({ message: { ...event().message!, message_type: "audio", content: JSON.stringify({ file_key: "audio" }) } }), "cli_floral")).toBeUndefined();
    expect(normalizeFeishuMessageEvent(event({ message: { ...event().message!, content: "{bad-json" } }), "cli_floral")).toBeUndefined();
  });
});
