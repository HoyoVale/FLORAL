import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createSearxngRuntimeAdoptionReport,
  removeSearxngRuntimeAdoptionReport,
  writeSearxngRuntimeAdoptionReport,
} from "../src/config/adoption/searxng-runtime-preparation-adoption.js";
import { loadRuntimeCompatibilityCatalog } from "../src/config/diagnostics/config-diagnostics.js";
import { resolveConfigurationAuthority } from "../src/config/federation/config-authority.js";
import { loadProjectEnv } from "../src/config/load-project-env.js";
import {
  buildSearxngRuntimePreparationContract,
  prepareLegacySearxngRuntime,
  prepareUnifiedSearxngRuntime,
} from "../src/config/search/searxng-runtime-preparation.js";
import { checkSearxng } from "../src/search/searxng.js";
import { observeSearxngRuntime } from "../src/search/searxng-runtime-observation.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadProjectEnv(join(repositoryRoot, ".env"));
const authority = await resolveConfigurationAuthority({ repositoryRoot, environment: process.env });
const compatibility = await loadRuntimeCompatibilityCatalog(repositoryRoot);
const command = process.argv[2] ?? "health";
const infraRoot = join(repositoryRoot, "infra", "searxng");
const composeFile = join(infraRoot, "compose.yaml");
const unifiedRequired = authority.effective.runtime.adoption.searxng.mode === "unified";

try {
  switch (command) {
    case "prepare": {
      const preparation = await prepareWithFallback();
      console.log(`searxng.prepare.mode=${preparation}`);
      console.log("searxng.prepare=ok");
      break;
    }
    case "up":
      await startWithAdoption();
      console.log("searxng.up=ok");
      break;
    case "down":
      await runDockerCompose(["down"]);
      console.log("searxng.down=ok");
      break;
    case "status":
      await runDockerCompose(["ps"]);
      break;
    case "health":
      await printHealth();
      break;
    default:
      throw new Error(`Unknown SearXNG command: ${command}. Expected prepare|up|down|status|health`);
  }
} catch (error) {
  console.error(`searxng.error=${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

async function prepareWithFallback(): Promise<"unified" | "legacy"> {
  if (!unifiedRequired) {
    await prepareLegacySearxngRuntime(repositoryRoot, authority.effective);
    return "legacy";
  }
  try {
    await prepareUnifiedSearxngRuntime({
      repositoryRoot,
      config: authority.effective,
      validatedImages: compatibility.searxng.validatedImages,
    });
    return "unified";
  } catch (error) {
    console.warn(`searxng.prepare.rollback=legacy:${safeErrorType(error)}`);
    await prepareLegacySearxngRuntime(repositoryRoot, authority.effective);
    return "legacy";
  }
}

async function startWithAdoption(): Promise<void> {
  if (!unifiedRequired) {
    await removeSearxngRuntimeAdoptionReport(repositoryRoot);
    await prepareLegacySearxngRuntime(repositoryRoot, authority.effective);
    await runDockerCompose(["up", "-d"]);
    await waitForHealth();
    return;
  }

  const target = buildSearxngRuntimePreparationContract(authority.effective);
  await removeSearxngRuntimeAdoptionReport(repositoryRoot);
  try {
    const prepared = await prepareUnifiedSearxngRuntime({
      repositoryRoot,
      config: authority.effective,
      validatedImages: compatibility.searxng.validatedImages,
    });
    await runDockerCompose(["up", "-d"]);
    await waitForHealth();
    const observation = await observeCurrentConfig();
    if (observation.status !== "observed" || !observation.fingerprint || observation.engines.length === 0) {
      throw new Error(`Unified SearXNG runtime observation failed: ${observation.errorType ?? observation.status}`);
    }
    const report = createSearxngRuntimeAdoptionReport({
      status: "active",
      activePreparation: "unified",
      effectiveFingerprint: authority.effectiveFingerprint,
      target,
      active: prepared.contract,
      observation,
      fallbackUsed: false,
      reasonCode: "unified-observed",
    });
    const path = await writeSearxngRuntimeAdoptionReport(repositoryRoot, report);
    console.log(`searxng.adoption.report_fingerprint=${report.reportFingerprint}`);
    console.log(`searxng.adoption.report_path=${path}`);
    console.log("searxng.adoption=active");
    return;
  } catch (startupError) {
    console.warn(`searxng.adoption.rollback=legacy:${safeErrorType(startupError)}`);
    let fallbackError: unknown;
    try {
      await runDockerCompose(["down"]).catch(() => undefined);
      const legacy = await prepareLegacySearxngRuntime(repositoryRoot, authority.effective);
      await runDockerCompose(["up", "-d"]);
      await waitForHealth();
      const observation = await observeCurrentConfig();
      const report = createSearxngRuntimeAdoptionReport({
        status: "rolled-back",
        activePreparation: "legacy",
        effectiveFingerprint: authority.effectiveFingerprint,
        target,
        active: legacy.contract,
        observation,
        fallbackUsed: true,
        reasonCode: "unified-failed-legacy-recovered",
        startupError,
      });
      const path = await writeSearxngRuntimeAdoptionReport(repositoryRoot, report);
      console.log(`searxng.adoption.report_fingerprint=${report.reportFingerprint}`);
      console.log(`searxng.adoption.report_path=${path}`);
      console.log("searxng.adoption=rolled-back");
      return;
    } catch (error) {
      fallbackError = error;
    }
    const failed = createSearxngRuntimeAdoptionReport({
      status: "failed",
      activePreparation: "none",
      effectiveFingerprint: authority.effectiveFingerprint,
      target,
      fallbackUsed: true,
      reasonCode: "unified-and-legacy-failed",
      startupError,
      fallbackError,
    });
    await writeSearxngRuntimeAdoptionReport(repositoryRoot, failed).catch(() => undefined);
    throw new AggregateError([startupError, fallbackError], "Unified and legacy SearXNG startup both failed");
  }
}

async function observeCurrentConfig() {
  return observeSearxngRuntime(
    authority.effective.search.service_url,
    authority.effective.search.request_timeout_ms,
    compatibility.searxng.configEndpoint,
  );
}

async function waitForHealth(): Promise<void> {
  const deadline = Date.now() + 90_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await checkSearxng(
        authority.effective.search.service_url,
        authority.effective.search.request_timeout_ms,
      );
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_500));
    }
  }
  throw new Error(
    `SearXNG did not become healthy within 90 seconds: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

async function printHealth(): Promise<void> {
  const result = await checkSearxng(
    authority.effective.search.service_url,
    authority.effective.search.request_timeout_ms,
  );
  console.log(`searxng.url=${result.endpoint}`);
  console.log(`searxng.results=${result.resultCount}`);
  console.log("searxng.health=ok");
}

async function runDockerCompose(args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn("docker", ["compose", "-f", composeFile, ...args], {
      cwd: infraRoot,
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(
        `docker compose ${args.join(" ")} failed with ${signal ? `signal ${signal}` : `exit code ${String(code)}`}`,
      ));
    });
  });
}

function safeErrorType(error: unknown): string {
  return error instanceof Error && error.name.trim() !== "" ? error.name : "Error";
}
