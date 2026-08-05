import { describe, expect, it } from "vitest";
import { MockAgentRuntime } from "../src/agent/mock-agent.js";

describe("mock agent", () => {
  it("keeps an existing thread id", async () => {
    const agent = new MockAgentRuntime();
    const result = await agent.run({ threadId: "thread-a", text: "hello", cwd: "." });
    expect(result.threadId).toBe("thread-a");
    expect(result.finalText).toContain("hello");
  });
});
