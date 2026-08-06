import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { loadEnv } from "../src/config/env.js";
import { loadProjectEnv } from "../src/config/load-project-env.js";
import { checkSearxng } from "../src/search/searxng.js";

loadProjectEnv();
const env = loadEnv();
const command = process.argv[2] ?? "health";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const infraRoot = join(repositoryRoot, "infra", "searxng");
const composeFile = join(infraRoot, "compose.yaml");
const templateFile = join(infraRoot, "settings.template.yml");
const runtimeRoot = join(infraRoot, "runtime");
const secretFile = join(runtimeRoot, "secret");
const settingsFile = join(runtimeRoot, "settings.yml");

try {
  switch (command) {
    case "prepare":
      await prepareRuntime();
      console.log("searxng.prepare=ok");
      break;
    case "up":
      await prepareRuntime();
      await runDockerCompose(["up", "-d"]);
      await waitForHealth();
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
      throw new Error(
        `Unknown SearXNG command: ${command}. Expected prepare|up|down|status|health`,
      );
  }
} catch (error) {
  console.error(`searxng.error=${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

async function prepareRuntime(): Promise<void> {
  await mkdir(runtimeRoot, { recursive: true });
  const template = await readFile(templateFile, "utf8");

  let secret: string;
  try {
    secret = (await readFile(secretFile, "utf8")).trim();
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    secret = randomBytes(32).toString("hex");
    await writeFile(secretFile, `${secret}\n`, { encoding: "utf8", mode: 0o600 });
  }

  if (!/^[a-f0-9]{64}$/.test(secret)) {
    throw new Error("SearXNG runtime secret is malformed; remove infra/searxng/runtime and prepare again");
  }

  const rendered = template.replace("__FLORAL_SEARXNG_SECRET__", secret);
  if (rendered === template) {
    throw new Error("SearXNG settings template did not contain the secret placeholder");
  }

  await writeFile(settingsFile, rendered, { encoding: "utf8", mode: 0o600 });
  await chmod(secretFile, 0o600);
  await chmod(settingsFile, 0o600);
}

async function waitForHealth(): Promise<void> {
  const deadline = Date.now() + 90_000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      await checkSearxng(env.SEARXNG_URL, env.SEARXNG_REQUEST_TIMEOUT_MS);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_500));
    }
  }

  throw new Error(
    `SearXNG did not become healthy within 90 seconds: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

async function printHealth(): Promise<void> {
  const result = await checkSearxng(
    env.SEARXNG_URL,
    env.SEARXNG_REQUEST_TIMEOUT_MS,
  );
  console.log(`searxng.url=${result.endpoint}`);
  console.log(`searxng.results=${result.resultCount}`);
  console.log("searxng.health=ok");
}

async function runDockerCompose(args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(
      "docker",
      ["compose", "-f", composeFile, ...args],
      {
        cwd: infraRoot,
        env: process.env,
        stdio: "inherit",
      },
    );

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(
        `docker compose ${args.join(" ")} failed with ${
          signal ? `signal ${signal}` : `exit code ${String(code)}`
        }`,
      ));
    });
  });
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "ENOENT";
}
