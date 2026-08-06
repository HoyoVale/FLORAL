import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../src/config/env.js";
import { loadProjectEnv } from "../src/config/load-project-env.js";
import { checkSearxng } from "../src/search/searxng.js";
import { parsePinnedSearxngImage } from "../src/search/searxng-image.js";

loadProjectEnv();
const env = loadEnv();
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const composeFile = join(repositoryRoot, "infra", "searxng", "compose.yaml");

try {
  const composeText = await readFile(composeFile, "utf8");
  const image = parsePinnedSearxngImage(composeText);
  const dockerVersion = await runCapture("docker", ["version", "--format", "{{.Server.Version}}"]);
  const composeVersion = await runCapture("docker", ["compose", "version", "--short"]);
  await runCapture("docker", ["compose", "-f", composeFile, "config", "--quiet"]);
  const imageDigests = await runCapture("docker", [
    "image",
    "inspect",
    image,
    "--format",
    "{{json .RepoDigests}}",
  ]);
  const imagePresent = imageDigests.includes(image.split("@")[1] ?? "");
  if (!imagePresent) {
    throw new Error("Pinned SearXNG image digest is not present in the local image metadata");
  }
  const { state, health } = await waitForContainerHealth();
  const search = await checkSearxng(env.SEARXNG_URL, env.SEARXNG_REQUEST_TIMEOUT_MS);

  console.log(`searxng.docker_version=${dockerVersion}`);
  console.log(`searxng.compose_version=${composeVersion}`);
  console.log(`searxng.image=${image}`);
  console.log(`searxng.image_present=${imagePresent}`);
  console.log(`searxng.container_state=${state}`);
  console.log(`searxng.container_health=${health}`);
  console.log(`searxng.results=${search.resultCount}`);
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

async function waitForContainerHealth(): Promise<{ state: string; health: string }> {
  const deadline = Date.now() + 60_000;
  let lastState = "unknown";
  let lastHealth = "unknown";

  while (Date.now() < deadline) {
    const stateText = await runCapture("docker", [
      "inspect",
      "floral-searxng",
      "--format",
      "{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}",
    ]);
    [lastState = "unknown", lastHealth = "unknown"] = stateText.split("|", 2);
    if (lastState === "running" && lastHealth === "healthy") {
      return { state: lastState, health: lastHealth };
    }
    if (["dead", "exited", "removing"].includes(lastState)) {
      break;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }

  throw new Error(
    `SearXNG container did not become healthy: state=${lastState} health=${lastHealth}`,
  );
}
