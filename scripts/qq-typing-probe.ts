import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  FileKVStore,
  QQBot,
  kvSessionPersistence,
  type QQBotInboundMessage,
  type ReplyTarget,
} from "@tencent-connect/qqbot-nodejs";
import { loadEnv } from "../src/config/env.js";
import { resolveConfigurationAuthority } from "../src/config/federation/config-authority.js";
import { loadProjectEnv } from "../src/config/load-project-env.js";
import {
  buildQqRuntimeOptionsContract,
  resolveQqRuntimeCredentials,
} from "../src/config/qq/qq-runtime-options.js";
import {
  acquireProbeStackGuard,
  ProbeStackBusyError,
  type ProbeStackGuard,
} from "../src/service/probe-stack-guard.js";

const DEFAULT_VISIBLE_SECONDS = 20;
const REFRESH_MS = 2_500;

loadProjectEnv();
const env = loadEnv();
await runProbe();

async function runProbe(): Promise<void> {
  let guard: ProbeStackGuard;
  try {
    guard = await acquireProbeStackGuard(env.FLORAL_INSTANCE_LOCK_PATH);
  } catch (error) {
    if (error instanceof ProbeStackBusyError) {
      console.log("qq.typing_probe.blocked_reason=floral-stack-already-running");
      console.log(`qq.typing_probe.blocked_pid=${String(error.pid)}`);
      console.log("qq.typing_probe.instructions=run-service-stop-before-probe");
      console.log("qq.typing_probe.result=blocked");
      process.exitCode = 2;
      return;
    }
    throw error;
  }

  try {
    await runExclusiveProbe();
  } finally {
    await guard.release();
  }
}

async function runExclusiveProbe(): Promise<void> {
  const repositoryRoot = process.cwd();
  const authority = await resolveConfigurationAuthority({
    repositoryRoot,
    environment: process.env,
  });
  const contract = buildQqRuntimeOptionsContract(authority.effective);
  const credentials = resolveQqRuntimeCredentials(authority, process.env);
  const visibleSeconds = parseVisibleSeconds(process.argv.slice(2));
  const sessionRoot = isAbsolute(contract.session.root)
    ? resolve(contract.session.root)
    : resolve(repositoryRoot, contract.session.root);
  const accountId = `floral-typing-probe-${createHash("sha256")
    .update(credentials.appId)
    .digest("hex")
    .slice(0, 16)}`;
  const sessionDir = resolve(sessionRoot, "qq-typing-probe", accountId);
  await mkdir(sessionDir, { recursive: true });

  const bot = new QQBot({
    appId: credentials.appId,
    appSecret: credentials.appSecret,
    accountId,
    sessionPersistence: kvSessionPersistence({
      store: new FileKVStore({ dir: sessionDir, fileName: "session.json" }),
      accountId,
    }),
    tokenPrefetch: contract.sdk.tokenPrefetch,
    logger: createProbeLogger(),
  });

  const abortController = new AbortController();
  const ready = deferred<void>();
  const completion = deferred<void>();
  let readySettled = false;
  let messageHandled = false;
  let runPromise: Promise<void> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const settleReady = () => {
    if (readySettled) return;
    readySettled = true;
    ready.resolve(undefined);
  };

  bot.on("ready", settleReady);
  bot.on("resumed", settleReady);
  bot.on("error", (error: Error) => {
    if (!readySettled) {
      readySettled = true;
      ready.reject(error);
    }
    if (!messageHandled) completion.reject(error);
  });
  bot.on("message", async (_context, message: QQBotInboundMessage) => {
    if (messageHandled || message.replyTarget.scope !== "c2c") return;
    messageHandled = true;
    try {
      await exerciseTyping(bot, message, visibleSeconds);
      completion.resolve(undefined);
    } catch (error) {
      completion.reject(error);
    }
  });

  process.once("SIGINT", () => {
    completion.reject(new Error("QQ typing probe interrupted"));
  });

  try {
    console.log("qq.typing_probe.mode=direct-sdk-c2c");
    console.log("qq.typing_probe.exclusive_lock=ok");
    console.log(`qq.typing_probe.sdk_version=${contract.expectedVersion}`);
    console.log(`qq.typing_probe.refresh_ms=${REFRESH_MS}`);
    console.log(`qq.typing_probe.visible_seconds=${visibleSeconds}`);

    runPromise = bot.start(abortController.signal);
    void runPromise.catch((error) => {
      if (!abortController.signal.aborted) completion.reject(error);
    });

    await withTimeout(
      ready.promise,
      contract.delivery.startupTimeoutMs,
      "QQ typing probe startup",
    );
    console.log("qq.typing_probe.gateway=ready");
    console.log("qq.typing_probe.instructions=send-one-private-message-to-bot-and-watch-mobile-qq");
    console.log("qq.typing_probe.waiting=true");

    timeout = setTimeout(() => {
      completion.reject(new Error(
        `QQ typing probe timed out after ${env.QQBOT_PROBE_TIMEOUT_MS}ms`,
      ));
    }, env.QQBOT_PROBE_TIMEOUT_MS);

    await completion.promise;
    console.log("qq.typing_probe.sdk_result=ok");
    console.log("qq.typing_probe.visual_result=manual-check-required");
    console.log("qq.typing_probe.result=ok");
  } finally {
    if (timeout) clearTimeout(timeout);
    abortController.abort();
    await Promise.allSettled([bot.stop(), runPromise]);
  }
}

async function exerciseTyping(
  bot: QQBot,
  message: QQBotInboundMessage,
  visibleSeconds: number,
): Promise<void> {
  const messageId = message.messageId?.trim();
  const target = message.replyTarget;
  if (!messageId || target.scope !== "c2c") {
    throw new Error("QQ typing probe received an incomplete C2C message");
  }

  console.log("qq.typing_probe.inbound=c2c");
  console.log("qq.typing_probe.target_shape=raw-reply-target");
  console.log("qq.typing_probe.phase=typing-start");

  const deadline = Date.now() + visibleSeconds * 1_000;
  let attempts = 0;
  while (Date.now() < deadline) {
    await bot.sendTyping(target as ReplyTarget);
    attempts += 1;
    console.log(`qq.typing_probe.signal=${attempts}:ok`);
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await delay(Math.min(REFRESH_MS, remainingMs));
  }

  console.log(`qq.typing_probe.signals=${attempts}`);
  console.log("qq.typing_probe.phase=typing-finished");
  await bot.sendText(
    { ...target, msgId: messageId },
    "FLORAL typing probe 已完成。若刚才约 20 秒内手机 QQ 仍完全没有显示“正在输入”，则 SDK 调用成功但当前 QQ 客户端/机器人能力未渲染该状态。",
  );
  console.log("qq.typing_probe.passive_reply=ok");
}

function parseVisibleSeconds(args: string[]): number {
  const raw = args.find((arg) => arg.startsWith("--seconds="))?.slice("--seconds=".length);
  if (!raw) return DEFAULT_VISIBLE_SECONDS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 5 || value > 60) {
    throw new Error("--seconds must be an integer between 5 and 60");
  }
  return value;
}

function createProbeLogger(): {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
} {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => console.error("qq.typing_probe.sdk_warn=reported"),
    error: () => console.error("qq.typing_probe.sdk_error=reported"),
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromiseFn, rejectPromiseFn) => {
    resolvePromise = resolvePromiseFn;
    rejectPromise = rejectPromiseFn;
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
