import { resolveConfigurationAuthority } from "../src/config/federation/config-authority.js";
import { loadProjectEnv } from "../src/config/load-project-env.js";
import { readDeepSeekCostGuardSnapshot } from "../src/runtime/cost/deepseek-cost-guard.js";

loadProjectEnv();
const repositoryRoot = process.cwd();
const authority = await resolveConfigurationAuthority({
  repositoryRoot,
  environment: process.env,
});
const snapshot = await readDeepSeekCostGuardSnapshot(
  repositoryRoot,
  authority.effective.runtime.cost_guard,
);
const command = process.argv[2] ?? "show";

if (command === "json") {
  console.log(JSON.stringify(snapshot, null, 2));
} else if (command === "show" || command === "check") {
  for (const line of renderCostGuardSnapshot(snapshot)) console.log(line);
  if (command === "check" && snapshot.blockedReason) process.exitCode = 2;
} else {
  throw new Error(`Unknown cost guard command: ${command}`);
}

function renderCostGuardSnapshot(snapshot: Awaited<ReturnType<typeof readDeepSeekCostGuardSnapshot>>): string[] {
  return [
    `cost.guard.enabled=${String(snapshot.enabled)}`,
    `cost.guard.requests.minute=${String(snapshot.requests.minute)}/${String(snapshot.limits.requestsMinute)}`,
    `cost.guard.requests.hour=${String(snapshot.requests.hour)}/${String(snapshot.limits.requestsHour)}`,
    `cost.guard.requests.day=${String(snapshot.requests.day)}/${String(snapshot.limits.requestsDay)}`,
    `cost.guard.tokens.hour=${String(snapshot.tokens.hour)}/${String(snapshot.limits.tokensHour)}`,
    `cost.guard.tokens.day=${String(snapshot.tokens.day)}/${String(snapshot.limits.tokensDay)}`,
    `cost.guard.estimated_cny.hour=${snapshot.estimatedCostCny.hour.toFixed(6)}/${snapshot.limits.costCnyHour.toFixed(2)}`,
    `cost.guard.estimated_cny.day=${snapshot.estimatedCostCny.day.toFixed(6)}/${snapshot.limits.costCnyDay.toFixed(2)}`,
    `cost.guard.unknown_usage.hour=${String(snapshot.unknownUsageHour)}`,
    `cost.guard.blocked=${snapshot.blockedReason ?? "none"}`,
    ...(snapshot.retryAfterMs !== undefined
      ? [`cost.guard.retry_after_ms=${String(snapshot.retryAfterMs)}`]
      : []),
    "cost.guard=ok",
  ];
}
