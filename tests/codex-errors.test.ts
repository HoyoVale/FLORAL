import { describe, expect, it } from "vitest";
import { classifyCodexFailure } from "../src/agent/codex-errors.js";

describe("Codex error classification", () => {
  it("classifies quota errors", () => {
    const error = classifyCodexFailure({
      error: {
        message: "You've hit your usage limit.",
        codexErrorInfo: { type: "UsageLimitExceeded" },
      },
    });

    expect(error.kind).toBe("usage_limit");
    expect(error.retryable).toBe(false);
  });

  it("classifies authentication and network errors", () => {
    expect(classifyCodexFailure({
      error: { message: "Unauthorized", codexErrorInfo: "Unauthorized" },
    }).kind).toBe("authentication");

    const network = classifyCodexFailure({
      error: {
        message: "upstream connection failed",
        codexErrorInfo: { ResponseStreamConnectionFailed: { httpStatusCode: 503 } },
      },
    });
    expect(network.kind).toBe("network");
    expect(network.retryable).toBe(true);
  });
});
