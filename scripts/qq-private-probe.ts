import { resolve } from "node:path";
import type { AppEnv } from "../src/config/env.js";
import { loadEnv } from "../src/config/env.js";
import { resolveConfigurationAuthority } from "../src/config/federation/config-authority.js";
import { loadProjectEnv } from "../src/config/load-project-env.js";
import {
  acquireProbeStackGuard,
  ProbeStackBusyError,
  type ProbeStackGuard,
} from "../src/service/probe-stack-guard.js";
import { createUnifiedQqTransportForProbe } from "../src/transport/qq/qq-runtime-adoption-transport.js";

loadProjectEnv();
const env = loadEnv();
await runProbe(env);

async function runProbe(env: AppEnv): Promise<void> {
  if (!env.QQBOT_APP_ID || !env.QQBOT_APP_SECRET) {
    throw new Error("QQ private probe requires QQBOT_APP_ID and QQBOT_APP_SECRET");
  }

  let guard: ProbeStackGuard;
  try {
    guard = await acquireProbeStackGuard(env.FLORAL_INSTANCE_LOCK_PATH);
  } catch (error) {
    if (error instanceof ProbeStackBusyError) {
      console.log("qq.probe.mode=c2c-passive-reply");
      console.log(`qq.probe.blocked_pid=${String(error.pid)}`);
      console.log("qq.probe.blocked_reason=floral-stack-already-running");
      console.log("qq.probe.instructions=run-service-stop-before-probe");
      console.log("qq.probe.result=blocked");
      process.exitCode = 2;
      return;
    }
    throw error;
  }

  try {
    await runExclusiveProbe(env);
  } finally {
    await guard.release();
  }
}

async function runExclusiveProbe(env: AppEnv): Promise<void> {
  const transport = createUnifiedQqTransportForProbe({
    repositoryRoot: process.cwd(),
    authority: await resolveConfigurationAuthority({
      repositoryRoot: process.cwd(),
      environment: process.env,
    }),
    environment: process.env,
  });

  const completion = deferred<void>();
  let messageHandled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stop = async () => {
    if (timer) clearTimeout(timer);
    await transport.stop();
  };

  process.once("SIGINT", () => {
    completion.reject(new Error("QQ private probe interrupted"));
  });

  try {
    console.log("qq.probe.mode=c2c-passive-reply");
    console.log("qq.probe.exclusive_lock=ok");
    console.log("qq.probe.waiting=true");

    await transport.start(async (message) => {
      if (messageHandled) return;
      messageHandled = true;

      console.log("qq.probe.inbound=c2c");
      console.log(`qq.probe.input_characters=${message.text.length}`);

      await transport.send({
        conversationId: message.identity.conversationId,
        text: "FLORAL_QQ_TRANSPORT_OK",
      });

      console.log("qq.probe.passive_reply=ok");
      completion.resolve(undefined);
    });

    console.log("qq.probe.gateway=ready");
    timer = setTimeout(() => {
      completion.reject(new Error(
        `QQ private probe timed out after ${env.QQBOT_PROBE_TIMEOUT_MS}ms`,
      ));
    }, env.QQBOT_PROBE_TIMEOUT_MS);

    await completion.promise;
    console.log("qq.probe.result=ok");
  } finally {
    await stop();
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}
