import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  FileKVStore,
  MsgType,
  QQBot,
  kvSessionPersistence,
  type InlineKeyboard,
  type InteractionEvent,
  type QQBotInboundMessage,
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

const DEFAULT_VISIBLE_SECONDS = 30;

loadProjectEnv();
const env = loadEnv();
await runProbe();

async function runProbe(): Promise<void> {
  let guard: ProbeStackGuard;
  try {
    guard = await acquireProbeStackGuard(env.FLORAL_INSTANCE_LOCK_PATH);
  } catch (error) {
    if (error instanceof ProbeStackBusyError) {
      console.log("qq.keyboard_probe.blocked_reason=floral-stack-already-running");
      console.log(`qq.keyboard_probe.blocked_pid=${String(error.pid)}`);
      console.log("qq.keyboard_probe.instructions=run-service-stop-before-probe");
      console.log("qq.keyboard_probe.result=blocked");
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
  const accountId = `floral-keyboard-probe-${createHash("sha256")
    .update(credentials.appId)
    .digest("hex")
    .slice(0, 16)}`;
  const sessionDir = resolve(sessionRoot, "qq-keyboard-probe", accountId);
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

  const wireAudit = installKeyboardWireAudit(bot);
  const abortController = new AbortController();
  const ready = deferred<void>();
  const completion = deferred<void>();
  let readySettled = false;
  let initialMessageHandled = false;
  let callbackCount = 0;
  let commandClickReceived = false;
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
    if (!initialMessageHandled) completion.reject(error);
  });

  bot.on("interaction", async (_context, event: InteractionEvent) => {
    if (event.type !== 11) return;
    const interactionId = event.id?.trim();
    if (!interactionId) return;

    // QQ 官方文档要求 type=11 的按钮互动在 3 秒内响应。
    try {
      await bot.acknowledgeInteraction(interactionId);
      console.log("qq.keyboard_probe.interaction_ack=ok");
    } catch (error) {
      console.log(`qq.keyboard_probe.interaction_ack=error:${safeErrorType(error)}`);
      return;
    }

    callbackCount += 1;
    const buttonId = event.data?.resolved?.button_id?.trim() ?? "";
    const buttonData = event.data?.resolved?.button_data?.trim() ?? "";
    console.log("qq.keyboard_probe.interaction=received");
    console.log(`qq.keyboard_probe.interaction.scene=${safeToken(event.scene ?? "unknown")}`);
    console.log(`qq.keyboard_probe.interaction.button_id=${safeToken(buttonId || "missing")}`);
    console.log(
      `qq.keyboard_probe.interaction.button_data_match=${
        buttonData === "keyboard-probe-callback" ? "true" : "false"
      }`,
    );
  });

  bot.on("message", async (_context, message: QQBotInboundMessage) => {
    if (message.replyTarget.scope !== "c2c") return;

    if (initialMessageHandled) {
      const normalized = message.content?.trim() ?? "";
      if (normalized.includes("keyboard-probe-command")) {
        commandClickReceived = true;
        console.log("qq.keyboard_probe.command_click=received");
      }
      return;
    }

    initialMessageHandled = true;
    try {
      await exerciseKeyboard(bot, message);
      console.log(`qq.keyboard_probe.observe_seconds=${visibleSeconds}`);
      await delay(visibleSeconds * 1_000);
      wireAudit.assertValid();

      console.log(`qq.keyboard_probe.wire_requests=${wireAudit.count()}`);
      console.log(`qq.keyboard_probe.callback_count=${callbackCount}`);
      console.log(
        `qq.keyboard_probe.command_click_received=${commandClickReceived ? "true" : "false"}`,
      );

      await bot.sendText(
        {
          ...message.replyTarget,
          msgId: message.messageId,
        },
        [
          "FLORAL keyboard probe 已完成。",
          "请记录手机 QQ 中 Probe A / Probe B 是否出现按钮，以及点击后是否有反馈。",
        ].join("\n"),
      );
      console.log("qq.keyboard_probe.passive_reply=ok");
      completion.resolve(undefined);
    } catch (error) {
      completion.reject(error);
    }
  });

  process.once("SIGINT", () => {
    completion.reject(new Error("QQ keyboard probe interrupted"));
  });

  try {
    console.log("qq.keyboard_probe.mode=direct-sdk-c2c");
    console.log("qq.keyboard_probe.protocol=qq-api-v2-strict-custom-keyboard");
    console.log("qq.keyboard_probe.exclusive_lock=ok");
    console.log(`qq.keyboard_probe.sdk_version=${contract.expectedVersion}`);
    console.log("qq.keyboard_probe.probe_a=callback-type-1");
    console.log("qq.keyboard_probe.probe_b=command-type-2");
    console.log("qq.keyboard_probe.removed_fields=group_id,click_limit");
    console.log(`qq.keyboard_probe.visible_seconds=${visibleSeconds}`);

    runPromise = bot.start(abortController.signal);
    void runPromise.catch((error) => {
      if (!abortController.signal.aborted) completion.reject(error);
    });

    await withTimeout(
      ready.promise,
      contract.delivery.startupTimeoutMs,
      "QQ keyboard probe startup",
    );
    console.log("qq.keyboard_probe.gateway=ready");
    console.log(
      "qq.keyboard_probe.instructions=send-one-private-message-and-watch-for-two-native-keyboards",
    );
    console.log("qq.keyboard_probe.waiting=true");

    timeout = setTimeout(() => {
      completion.reject(new Error(
        `QQ keyboard probe timed out after ${env.QQBOT_PROBE_TIMEOUT_MS}ms`,
      ));
    }, Math.max(env.QQBOT_PROBE_TIMEOUT_MS, visibleSeconds * 1_000 + 15_000));

    await completion.promise;
    console.log("qq.keyboard_probe.sdk_result=ok");
    console.log("qq.keyboard_probe.visual_result=manual-check-required");
    console.log("qq.keyboard_probe.result=ok");
  } finally {
    if (timeout) clearTimeout(timeout);
    abortController.abort();
    await Promise.allSettled([bot.stop(), runPromise]);
  }
}

async function exerciseKeyboard(
  bot: QQBot,
  message: QQBotInboundMessage,
): Promise<void> {
  const messageId = message.messageId?.trim();
  const target = message.replyTarget;
  if (!messageId || target.scope !== "c2c") {
    throw new Error("QQ keyboard probe received an incomplete C2C message");
  }

  console.log("qq.keyboard_probe.inbound=c2c");
  console.log("qq.keyboard_probe.phase=send-callback-keyboard");

  await bot.send({
    target: { ...target, msgId: messageId },
    msgType: MsgType.TEXT,
    content: "Probe A：官方 API v2 最小回调按钮（type=1）。",
    keyboard: callbackKeyboard(),
  });
  console.log("qq.keyboard_probe.probe_a_send=ok");

  await delay(750);

  console.log("qq.keyboard_probe.phase=send-command-keyboard");
  await bot.send({
    target: { ...target, msgId: messageId },
    msgType: MsgType.TEXT,
    content: "Probe B：官方 API v2 最小指令按钮（type=2）。",
    keyboard: commandKeyboard(),
  });
  console.log("qq.keyboard_probe.probe_b_send=ok");
  console.log("qq.keyboard_probe.phase=observe-client");
}

function callbackKeyboard(): InlineKeyboard {
  return {
    content: {
      rows: [{
        buttons: [{
          id: "probe-callback",
          render_data: {
            label: "确认回调",
            visited_label: "已点击",
            style: 1,
          },
          action: {
            type: 1,
            permission: { type: 2 },
            data: "keyboard-probe-callback",
          },
        }],
      }],
    },
  };
}

function commandKeyboard(): InlineKeyboard {
  // qqbot-nodejs 1.0.4 的 InlineKeyboard 类型尚未声明 API v2 已公开的
  // enter/reply 字段；send() 会透传 keyboard，因此这里仅为官方协议字段做窄化。
  return {
    content: {
      rows: [{
        buttons: [{
          id: "probe-command",
          render_data: {
            label: "发送指令",
            visited_label: "已发送",
            style: 3,
          },
          action: {
            type: 2,
            permission: { type: 2 },
            data: "keyboard-probe-command",
            enter: true,
            reply: false,
          },
        }],
      }],
    },
  } as unknown as InlineKeyboard;
}

interface WireAudit {
  count(): number;
  assertValid(): void;
}

function installKeyboardWireAudit(bot: QQBot): WireAudit {
  type RequestFn = (
    accessToken: string,
    method: string,
    path: string,
    body?: unknown,
  ) => Promise<unknown>;

  const client = bot.apiClient as unknown as { request: RequestFn };
  const originalRequest = client.request.bind(client) as RequestFn;
  let count = 0;
  let invalid = 0;

  client.request = async (accessToken, method, path, body) => {
    const record = asRecord(body);
    if (
      method === "POST"
      && isC2cMessagesPath(path)
      && record
      && record.keyboard !== undefined
    ) {
      count += 1;
      const keyboard = asRecord(record.keyboard);
      const content = asRecord(keyboard?.content);
      const rows = Array.isArray(content?.rows) ? content.rows : [];
      const firstRow = asRecord(rows[0]);
      const buttons = Array.isArray(firstRow?.buttons) ? firstRow.buttons : [];
      const firstButton = asRecord(buttons[0]);
      const action = asRecord(firstButton?.action);
      const permission = asRecord(action?.permission);

      const valid =
        record.msg_type === 0
        && typeof record.content === "string"
        && record.content.length > 0
        && typeof record.msg_id === "string"
        && record.msg_id.length > 0
        && Number.isInteger(record.msg_seq)
        && Number(record.msg_seq) >= 1
        && buttons.length === 1
        && typeof firstButton?.id === "string"
        && (action?.type === 1 || action?.type === 2)
        && action?.data !== undefined
        && permission?.type === 2
        && firstButton?.group_id === undefined
        && action?.click_limit === undefined;

      if (!valid) invalid += 1;
      console.log(`qq.keyboard_probe.wire.${count}.msg_type=${String(record.msg_type)}`);
      console.log(
        `qq.keyboard_probe.wire.${count}.msg_id=${
          typeof record.msg_id === "string" && record.msg_id.length > 0 ? "present" : "missing"
        }`,
      );
      console.log(`qq.keyboard_probe.wire.${count}.msg_seq=${String(record.msg_seq)}`);
      console.log(`qq.keyboard_probe.wire.${count}.action_type=${String(action?.type)}`);
      console.log(`qq.keyboard_probe.wire.${count}.permission_type=${String(permission?.type)}`);
      console.log(
        `qq.keyboard_probe.wire.${count}.legacy_extra_fields=${
          firstButton?.group_id === undefined && action?.click_limit === undefined
            ? "absent"
            : "present"
        }`,
      );
      console.log(`qq.keyboard_probe.wire.${count}.official_shape=${valid ? "ok" : "invalid"}`);
    }
    return await originalRequest(accessToken, method, path, body);
  };

  return {
    count: () => count,
    assertValid: () => {
      if (count < 2) {
        throw new Error(`Expected two keyboard wire requests, observed ${count}`);
      }
      if (invalid > 0) {
        throw new Error(`Observed ${invalid} keyboard request(s) outside the API v2 probe contract`);
      }
    },
  };
}

function isC2cMessagesPath(path: string): boolean {
  return /^\/v2\/users\/[^/]+\/messages$/u.test(path);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

function parseVisibleSeconds(args: string[]): number {
  const raw = args.find((arg) => arg.startsWith("--seconds="))?.slice("--seconds=".length);
  if (!raw) return DEFAULT_VISIBLE_SECONDS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 10 || value > 120) {
    throw new Error("--seconds must be an integer between 10 and 120");
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
    warn: () => console.error("qq.keyboard_probe.sdk_warn=reported"),
    error: () => console.error("qq.keyboard_probe.sdk_error=reported"),
  };
}

function safeErrorType(error: unknown): string {
  return error instanceof Error && error.name.trim() ? error.name : "Error";
}

function safeToken(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:/-]/gu, "_").slice(0, 96) || "unknown";
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

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
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
