import { timingSafeEqual } from "node:crypto";

export type GatewayCommand =
  | { type: "pair"; code: string | undefined }
  | { type: "new" }
  | { type: "status"; debug: boolean }
  | { type: "help" }
  | { type: "stop" }
  | { type: "mode"; value: string | undefined }
  | { type: "projects" }
  | { type: "project"; name: string | undefined }
  | { type: "chats" }
  | { type: "chat"; value: string | undefined }
  | { type: "approve"; approvalId: string | undefined }
  | { type: "approve-session"; approvalId: string | undefined }
  | { type: "deny"; approvalId: string | undefined };

export function parseGatewayCommand(text: string): GatewayCommand | undefined {
  const trimmed = text.trim();
  const pair = /^\/pair(?:\s+(.+))?$/i.exec(trimmed);
  if (pair) {
    return {
      type: "pair",
      code: pair[1]?.trim() || undefined,
    };
  }
  if (/^\/new$/i.test(trimmed)) return { type: "new" };
  const status = /^\/status(?:\s+(--debug|-d))?$/i.exec(trimmed);
  if (status) return { type: "status", debug: Boolean(status[1]) };
  if (/^\/help$/i.test(trimmed)) return { type: "help" };
  if (/^\/stop$/i.test(trimmed)) return { type: "stop" };
  if (/^\/projects$/i.test(trimmed)) return { type: "projects" };
  const project = /^\/project(?:\s+(.+))?$/i.exec(trimmed);
  if (project) {
    return { type: "project", name: project[1]?.trim() || undefined };
  }
  if (/^\/chats$/i.test(trimmed)) return { type: "chats" };
  const chat = /^\/chat(?:\s+(.+))?$/i.exec(trimmed);
  if (chat) {
    return { type: "chat", value: chat[1]?.trim() || undefined };
  }
  const mode = /^\/mode(?:\s+([A-Za-z-]+))?$/i.exec(trimmed);
  if (mode) {
    return { type: "mode", value: mode[1]?.trim().toLowerCase() || undefined };
  }
  const approveSession = /^\/approve-session(?:\s+([A-Za-z0-9]+))?$/i.exec(trimmed);
  if (approveSession) {
    return {
      type: "approve-session",
      approvalId: approveSession[1]?.trim().toUpperCase() || undefined,
    };
  }
  const approve = /^\/approve(?:\s+([A-Za-z0-9]+))?$/i.exec(trimmed);
  if (approve) {
    return { type: "approve", approvalId: approve[1]?.trim().toUpperCase() || undefined };
  }
  const deny = /^\/deny(?:\s+([A-Za-z0-9]+))?$/i.exec(trimmed);
  if (deny) {
    return { type: "deny", approvalId: deny[1]?.trim().toUpperCase() || undefined };
  }
  return undefined;
}

export function pairingCodeMatches(
  supplied: string | undefined,
  expected: string | undefined,
): boolean {
  if (!supplied || !expected) return false;
  const suppliedBytes = Buffer.from(supplied, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  if (suppliedBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(suppliedBytes, expectedBytes);
}

interface PairingAttemptState {
  failures: number;
  windowStartedAt: number;
  blockedUntil: number;
}

export class PairingAttemptLimiter {
  readonly #states = new Map<string, PairingAttemptState>();

  constructor(
    private readonly maxFailures = 5,
    private readonly windowMs = 10 * 60_000,
    private readonly blockMs = 15 * 60_000,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isInteger(maxFailures) || maxFailures <= 0) {
      throw new Error("Pairing max failures must be a positive integer");
    }
    if (!Number.isInteger(windowMs) || windowMs <= 0) {
      throw new Error("Pairing window must be a positive integer");
    }
    if (!Number.isInteger(blockMs) || blockMs <= 0) {
      throw new Error("Pairing block duration must be a positive integer");
    }
  }

  canAttempt(key: string): boolean {
    const current = this.#states.get(key);
    if (!current) return true;
    const now = this.now();
    if (current.blockedUntil > now) return false;
    if (now - current.windowStartedAt >= this.windowMs) {
      this.#states.delete(key);
    }
    return true;
  }

  recordFailure(key: string): void {
    const now = this.now();
    const current = this.#states.get(key);
    const state = !current || now - current.windowStartedAt >= this.windowMs
      ? { failures: 0, windowStartedAt: now, blockedUntil: 0 }
      : current;

    state.failures += 1;
    if (state.failures >= this.maxFailures) {
      state.blockedUntil = now + this.blockMs;
    }
    this.#states.set(key, state);
  }

  recordSuccess(key: string): void {
    this.#states.delete(key);
  }
}
