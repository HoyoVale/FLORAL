import { describe, expect, it } from "vitest";
import {
  PairingAttemptLimiter,
  pairingCodeMatches,
  parseGatewayCommand,
} from "../src/service/gateway-commands.js";

describe("gateway command parsing and pairing security", () => {
  it("parses only exact supported commands", () => {
    expect(parseGatewayCommand("/pair secret")).toEqual({
      type: "pair",
      code: "secret",
    });
    expect(parseGatewayCommand("/pair")).toEqual({
      type: "pair",
      code: undefined,
    });
    expect(parseGatewayCommand("/new")).toEqual({ type: "new" });
    expect(parseGatewayCommand("/status")).toEqual({ type: "status", debug: false });
    expect(parseGatewayCommand("/status --debug")).toEqual({ type: "status", debug: true });
    expect(parseGatewayCommand("/status -d")).toEqual({ type: "status", debug: true });
    expect(parseGatewayCommand("/help")).toEqual({ type: "help" });
    expect(parseGatewayCommand("/memory")).toEqual({ type: "native-memory-status" });
    expect(parseGatewayCommand("/memory status")).toEqual({ type: "native-memory-status" });
    expect(parseGatewayCommand("/stop")).toEqual({ type: "stop" });
    expect(parseGatewayCommand("/status now")).toBeUndefined();
    expect(parseGatewayCommand("hello")).toBeUndefined();
  });

  it("compares pairing codes without accepting missing or mismatched lengths", () => {
    expect(pairingCodeMatches("same-secret", "same-secret")).toBe(true);
    expect(pairingCodeMatches("same-secrex", "same-secret")).toBe(false);
    expect(pairingCodeMatches("short", "much-longer")).toBe(false);
    expect(pairingCodeMatches(undefined, "secret")).toBe(false);
    expect(pairingCodeMatches("secret", undefined)).toBe(false);
  });

  it("blocks after bounded failures and resets after the block expires", () => {
    let now = 1_000;
    const limiter = new PairingAttemptLimiter(
      3,
      10_000,
      20_000,
      () => now,
    );

    expect(limiter.canAttempt("identity")).toBe(true);
    limiter.recordFailure("identity");
    limiter.recordFailure("identity");
    expect(limiter.canAttempt("identity")).toBe(true);
    limiter.recordFailure("identity");
    expect(limiter.canAttempt("identity")).toBe(false);

    now += 20_001;
    expect(limiter.canAttempt("identity")).toBe(true);
  });

  it("clears failed-attempt state after success", () => {
    const limiter = new PairingAttemptLimiter(2, 10_000, 20_000, () => 1_000);
    limiter.recordFailure("identity");
    limiter.recordSuccess("identity");
    expect(limiter.canAttempt("identity")).toBe(true);
  });
});
