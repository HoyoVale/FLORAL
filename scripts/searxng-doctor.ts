import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRuntimeCompatibilityCatalog } from "../src/config/diagnostics/config-diagnostics.js";
import { resolveConfigurationAuthority } from "../src/config/federation/config-authority.js";
import { loadProjectEnv } from "../src/config/load-project-env.js";
import { buildSearxngRuntimePreparationContract } from "../src/config/search/searxng-runtime-preparation.js";
import { checkSearxng } from "../src/search/searxng.js";
import { observeSearxngRuntime } from "../src/search/searxng-runtime-observation.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadProjectEnv(join(repositoryRoot, ".env"));
const authority = await resolveConfigurationAuthority({ repositoryRoot, environment: process.env });
const compatibility = await loadRuntimeCompatibilityCatalog(repositoryRoot);
const contract = buildSearxngRuntimePreparationContract(authority.effective);
const composeFile = join(repositoryRoot, "infra", "searxng", "compose.yaml");

try {
  if (!compatibility.searxng.validatedImages.includes(contract.image)) {
    throw new Error("Configured SearXNG image is not in the reviewed compatibility catalog");
  }
  const dockerVersion = await runCapture("docker", ["version", "--format", "{{.Server.Version}}"]);
  const composeVersion = await runCapture("docker", ["compose", "version", "--short"]);
  await runCapture("docker", ["compose", "-f", composeFile, "config", "--quiet"]);
  const imageDigests = await runCapture("docker", [
    "image",
    "inspect",
    contract.image,
    "--format",
    "{{json .RepoDigests}}",
  ]);
  const imagePresent = imageDigests.includes(contract.image.split("@")[1] ?? "");
  if (!imagePresent) {
    throw new Error("Pinned SearXNG image digest is not present in the local image metadata");
  }
  const { state, health } = await waitForContainerHealth(authority.effective.search.container.container_name);
  const search = await checkSearxng(
    authority.effective.search.service_url,
    authority.effective.search.request_timeout_ms,
  );
  const observation = await observeSearxngRuntime(
    authority.effective.search.service_url,
    authority.effective.search.request_timeout_ms,
    compatibility.searxng.configEndpoint,
  );
  if (observation.status !== "observed" || !observation.fingerprint) {
    throw new Error(`SearXNG /config observation failed: ${observation.errorType ?? observation.status}`);
  }

  console.log(`searxng.docker_version=${dockerVersion}`);
  console.log(`searxng.compose_version=${composeVersion}`);
  console.log(`searxng.image=${contract.image}`);
  console.log(`searxng.image_present=${imagePresent}`);
  console.log(`searxng.runtime_fingerprint=${contract.runtimeFingerprint}`);
  console.log(`searxng.container_state=${state}`);
  console.log(`searxng.container_health=${health}`);
  console.log(`searxng.results=${search.resultCount}`);
  console.log(`searxng.config_fingerprint=${observation.fingerprint}`);
  console.log(`searxng.engines=${String(observation.engines.length)}`);
  console.log(`searxng.plugins=${String(observation.plugins.length)}`);
  console.log("searxng.doctor=ok");
} catch (error) {
  console.error(`searxng.doctor.error=${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

async function runCapture(command: string, args: string[]): Promise<string> {
  return await new Promise<string>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const maxBytes = 64 * 1024;

    child.stdout.on("data", (value: Buffer) => {
      stdoutBytes += value.length;
      if (stdoutBytes <= maxBytes) stdout.push(value);
    });
    child.stderr.on("data", (value: Buffer) => {
      stderrBytes += value.length;
      if (stderrBytes <= maxBytes) stderr.push(value);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise(Buffer.concat(stdout).toString("utf8").trim());
        return;
      }
      const detail = Buffer.concat(stderr).toString("utf8").trim();
      reject(new Error(
        `${command} ${args.join(" ")} failed with ${
          signal ? `signal ${signal}` : `exit code ${String(code)}`
        }${detail ? `: ${detail}` : ""}`,
      ));
    });
  });
}

async function waitForContainerHealth(containerName: string): Promise<{ state: string; health: string }> {
  const deadline = Date.now() + 60_000;
  let lastState = "unknown";
  let lastHealth = "unknown";

  while (Date.now() < deadline) {
    const stateText = await runCapture("docker", [
      "inspect",
      containerName,
      "--format",
      "{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}",
    ]);
    [lastState = "unknown", lastHealth = "unknown"] = stateText.split("|", 2);
    if (lastState === "running" && lastHealth === "healthy") return { state: lastState, health: lastHealth };
    if (["dead", "exited", "removing"].includes(lastState)) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }

  throw new Error(`SearXNG container did not become healthy: state=${lastState} health=${lastHealth}`);
}
