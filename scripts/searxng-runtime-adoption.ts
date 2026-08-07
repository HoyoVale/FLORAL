import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assessSearxngRuntimeAdoptionReport,
  readSearxngRuntimeAdoptionReport,
  renderSearxngRuntimeAdoptionReport,
} from "../src/config/adoption/searxng-runtime-preparation-adoption.js";
import { loadRuntimeCompatibilityCatalog } from "../src/config/diagnostics/config-diagnostics.js";
import { resolveConfigurationAuthority } from "../src/config/federation/config-authority.js";
import { loadProjectEnv } from "../src/config/load-project-env.js";
import { buildSearxngRuntimePreparationContract } from "../src/config/search/searxng-runtime-preparation.js";
import { observeSearxngRuntime } from "../src/search/searxng-runtime-observation.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadProjectEnv(join(repositoryRoot, ".env"));
const command = process.argv[2] ?? "show";
if (!new Set(["show", "json", "check"]).has(command)) {
  throw new Error(`Unsupported SearXNG runtime adoption command: ${command}`);
}

const authority = await resolveConfigurationAuthority({ repositoryRoot, environment: process.env });
const compatibility = await loadRuntimeCompatibilityCatalog(repositoryRoot);
const required = authority.effective.mcp.search.enabled
  && authority.effective.runtime.adoption.searxng.mode === "unified";
const contract = buildSearxngRuntimePreparationContract(authority.effective);
let report: Awaited<ReturnType<typeof readSearxngRuntimeAdoptionReport>>;
let invalid = false;
try {
  report = await readSearxngRuntimeAdoptionReport(repositoryRoot);
} catch {
  invalid = true;
}
const observation = required
  ? await observeSearxngRuntime(
      authority.effective.search.service_url,
      authority.effective.search.request_timeout_ms,
      compatibility.searxng.configEndpoint,
    )
  : undefined;
const currentStatus = !required
  ? "disabled"
  : invalid
    ? "invalid"
    : !report
      ? "missing"
      : assessSearxngRuntimeAdoptionReport(report, contract, observation);

if (command === "json") {
  process.stdout.write(`${JSON.stringify({
    required,
    currentStatus,
    runtimeFingerprint: contract.runtimeFingerprint,
    observation: observation ?? null,
    report: report ?? null,
  }, null, 2)}\n`);
} else if (report) {
  process.stdout.write(renderSearxngRuntimeAdoptionReport(report));
  process.stdout.write(`config.searxng_adoption.current_runtime_fingerprint=${contract.runtimeFingerprint}\n`);
  process.stdout.write(`config.searxng_adoption.current_observation_fingerprint=${observation?.fingerprint ?? "unavailable"}\n`);
  process.stdout.write(`config.searxng_adoption.current_status=${currentStatus}\n`);
} else {
  process.stdout.write(`config.searxng_adoption.required=${String(required)}\n`);
  process.stdout.write(`config.searxng_adoption.current_runtime_fingerprint=${contract.runtimeFingerprint}\n`);
  process.stdout.write(`config.searxng_adoption.current_observation_fingerprint=${observation?.fingerprint ?? "unavailable"}\n`);
  process.stdout.write(`config.searxng_adoption.current_status=${currentStatus}\n`);
}

if (command === "check" && required && currentStatus !== "active") process.exitCode = 2;
