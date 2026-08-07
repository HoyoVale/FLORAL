import { resolve } from "node:path";
import { resolveConfigurationAuthority } from "../src/config/federation/config-authority.js";
import {
  buildFeishuRuntimeOptionsContract,
  resolveFeishuRuntimeCredentials,
} from "../src/config/feishu/feishu-runtime-options.js";
import { loadProjectEnv } from "../src/config/load-project-env.js";
import type { OutgoingMediaMessage } from "../src/core/types.js";
import { FeishuTransport } from "../src/transport/feishu/feishu-transport.js";

const DEFAULT_TIMEOUT_MS = 120_000;

loadProjectEnv();

const repositoryRoot = process.cwd();
const authority = await resolveConfigurationAuthority({
  repositoryRoot,
  environment: process.env,
});
const contract = buildFeishuRuntimeOptionsContract(authority.effective);
const credentials = resolveFeishuRuntimeCredentials(authority, process.env);
const timeoutMs = parseTimeout(process.env.FEISHU_PROBE_TIMEOUT_MS);
const assets = parseArgs(process.argv.slice(2));

if (assets.length === 0) {
  throw new Error(
    "Provide at least one asset: --image=/absolute/path.png or --file=/absolute/path",
  );
}

let handled = false;
let settled = false;
let resolveCompletion!: () => void;
let rejectCompletion!: (error: unknown) => void;
const completion = new Promise<void>((resolvePromise, rejectPromise) => {
  resolveCompletion = resolvePromise;
  rejectCompletion = rejectPromise;
});
const finish = (error?: unknown) => {
  if (settled) return;
  settled = true;
  if (error) rejectCompletion(error);
  else resolveCompletion();
};

const transport = new FeishuTransport({
  appId: credentials.appId,
  appSecret: credentials.appSecret,
  expectedSdkVersion: contract.expectedVersion,
  startupTimeoutMs: contract.delivery.startupTimeoutMs,
  outboundTimeoutMs: contract.delivery.outboundTimeoutMs,
  textChunkBytes: contract.delivery.textChunkBytes,
  maxReplyChunks: contract.delivery.maxReplyChunks,
  onFatal: finish,
});

const timer = setTimeout(() => {
  finish(new Error(`Feishu media probe timed out after ${String(timeoutMs)}ms`));
}, timeoutMs);

try {
  console.log("feishu.media_probe.mode=production-transport-isolation");
  console.log("feishu.media_probe.gateway=bypassed");
  console.log(`feishu.media_probe.assets=${String(assets.length)}`);
  console.log("feishu.media_probe.instructions=send-one-private-text-message-to-the-bot");

  await transport.start(async (message) => {
    if (handled) return;
    handled = true;

    void (async () => {
      try {
        console.log("feishu.media_probe.inbound=p2p-text");
        for (const asset of assets) {
          await transport.sendMedia({
            ...asset,
            conversationId: message.identity.conversationId,
          });
          console.log(`feishu.media_probe.sent=${asset.kind}`);
        }
        finish();
      } catch (error) {
        finish(error);
      }
    })();
  });

  await completion;
  console.log("feishu.media_probe.result=ok");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`feishu.media_probe.result=error:${sanitize(message)}`);
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  await transport.stop().catch(() => undefined);
}

function parseArgs(args: string[]): Array<Omit<OutgoingMediaMessage, "conversationId">> {
  const caption = args.find((value) => value.startsWith("--caption="))
    ?.slice("--caption=".length);
  const values: Array<Omit<OutgoingMediaMessage, "conversationId">> = [];

  for (const arg of args) {
    if (arg.startsWith("--image=")) {
      values.push({
        kind: "image",
        localPath: resolve(arg.slice("--image=".length)),
        ...(caption ? { caption } : {}),
      });
    } else if (arg.startsWith("--file=")) {
      values.push({
        kind: "file",
        localPath: resolve(arg.slice("--file=".length)),
        ...(caption ? { caption } : {}),
      });
    }
  }
  return values;
}

function parseTimeout(value: string | undefined): number {
  if (!value?.trim()) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 10_000 || parsed > 10 * 60_000) {
    throw new Error("FEISHU_PROBE_TIMEOUT_MS must be an integer between 10000 and 600000");
  }
  return parsed;
}

function sanitize(value: string): string {
  return value.replace(/[^\x20-\x7E\u4E00-\u9FFF]/gu, "_").slice(0, 240);
}
