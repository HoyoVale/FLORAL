import { CodexAppServerRuntime } from "../src/agent/codex-app-server.js";
import { CodexRuntimeError } from "../src/agent/codex-errors.js";

const prompt = process.argv.slice(2).join(" ") || "只回复：FLORAL_CODEX_PROBE_OK";
const command = process.env.CODEX_COMMAND?.trim() || "codex";
const args = splitCommandLine(process.env.CODEX_ARGS?.trim() || "app-server");
const model = nonEmpty(process.env.CODEX_MODEL);
const timeoutMs = readPositiveInteger(process.env.CODEX_REQUEST_TIMEOUT_MS, 120_000);
const cwd = process.env.CODEX_CWD?.trim() || process.cwd();

const runtime = new CodexAppServerRuntime({
  command,
  args,
  requestTimeoutMs: timeoutMs,
  defaultModel: model,
});

console.log(`probe.command=${command} ${args.join(" ")}`);
console.log(`probe.cwd=${cwd}`);
console.log(`probe.model=${model ?? "<codex-default>"}`);

try {
  await runtime.start();
  console.log("probe.initialize=ok");

  const result = await runtime.run(
    { text: prompt, cwd, ...(model ? { model } : {}) },
    (event) => {
      if (event.type === "run.started") console.log(`probe.thread=${event.threadId}`);
      if (event.type === "assistant.delta") process.stdout.write(event.text);
    },
  );

  if (result.finalText) {
    process.stdout.write(`\nprobe.final=${JSON.stringify(result.finalText)}\n`);
  }
  console.log("probe.result=success");
} catch (error) {
  const failure = error instanceof CodexRuntimeError
    ? error
    : new CodexRuntimeError({
        kind: "unknown",
        message: error instanceof Error ? error.message : String(error),
        cause: error,
      });

  console.error(`probe.error.kind=${failure.kind}`);
  console.error(`probe.error.retryable=${String(failure.retryable)}`);
  console.error(`probe.error.message=${failure.message}`);

  if (failure.kind === "usage_limit") {
    console.log("probe.result=provider-reached-usage-limited");
    process.exitCode = 0;
  } else {
    console.log("probe.result=failed");
    process.exitCode = 1;
  }
} finally {
  await runtime.stop();
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function splitCommandLine(value: string): string[] {
  const matches = value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return matches.map((part) => {
    if ((part.startsWith('"') && part.endsWith('"')) || (part.startsWith("'") && part.endsWith("'"))) {
      return part.slice(1, -1);
    }
    return part;
  });
}
