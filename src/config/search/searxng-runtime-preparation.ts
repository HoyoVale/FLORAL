import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  renderSearxngCompose,
  renderSearxngSettings,
  SEARXNG_SECRET_PLACEHOLDER,
} from "../adapters/searxng-native-config.js";
import { normalizeNativeConfigText } from "../adapters/native-config-types.js";
import type { EffectiveConfig } from "../federation/config-authority.js";
import { parsePinnedSearxngImage } from "../../search/searxng-image.js";

export interface SearxngRuntimePreparationContract {
  schemaVersion: 1;
  phase: "4.0E5";
  image: string;
  serviceUrl: string;
  requestTimeoutMs: number;
  composeFingerprint: string;
  settingsTemplateFingerprint: string;
  runtimeFingerprint: string;
}

export interface SearxngPreparedRuntime {
  contract: SearxngRuntimePreparationContract;
  composeFile: string;
  settingsFile: string;
  secretFile: string;
  preparation: "unified" | "legacy";
}

export function buildSearxngRuntimePreparationContract(
  config: EffectiveConfig,
): SearxngRuntimePreparationContract {
  const compose = normalizeNativeConfigText(renderSearxngCompose(config));
  const settingsTemplate = normalizeNativeConfigText(renderSearxngSettings(config));
  const image = parsePinnedSearxngImage(compose);
  const withoutFingerprint = {
    schemaVersion: 1 as const,
    phase: "4.0E5" as const,
    image,
    serviceUrl: config.search.service_url,
    requestTimeoutMs: config.search.request_timeout_ms,
    composeFingerprint: fingerprintText(compose),
    settingsTemplateFingerprint: fingerprintText(settingsTemplate),
  };
  return {
    ...withoutFingerprint,
    runtimeFingerprint: fingerprint(withoutFingerprint),
  };
}

export async function prepareUnifiedSearxngRuntime(input: {
  repositoryRoot: string;
  config: EffectiveConfig;
  validatedImages: readonly string[];
}): Promise<SearxngPreparedRuntime> {
  const repositoryRoot = resolve(input.repositoryRoot);
  const infraRoot = join(repositoryRoot, "infra", "searxng");
  const runtimeRoot = join(infraRoot, "runtime");
  const composeFile = join(infraRoot, "compose.yaml");
  const settingsTemplateFile = join(infraRoot, "settings.template.yml");
  const settingsFile = join(runtimeRoot, "settings.yml");
  const secretFile = join(runtimeRoot, "secret");
  const contract = buildSearxngRuntimePreparationContract(input.config);

  if (!input.validatedImages.includes(contract.image)) {
    throw new Error("Configured SearXNG image is not in the reviewed runtime compatibility catalog");
  }

  const [checkedCompose, checkedSettings] = await Promise.all([
    readFile(composeFile, "utf8"),
    readFile(settingsTemplateFile, "utf8"),
  ]);
  const renderedCompose = normalizeNativeConfigText(renderSearxngCompose(input.config));
  const renderedSettings = normalizeNativeConfigText(renderSearxngSettings(input.config));
  if (normalizeNativeConfigText(checkedCompose) !== renderedCompose) {
    throw new Error("Checked-in SearXNG compose.yaml drifted from the unified renderer");
  }
  if (normalizeNativeConfigText(checkedSettings) !== renderedSettings) {
    throw new Error("Checked-in SearXNG settings template drifted from the unified renderer");
  }

  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  await chmod(runtimeRoot, 0o700).catch(() => undefined);
  const secret = await readOrCreateSecret(secretFile);
  const effectiveSettings = renderedSettings.replace(SEARXNG_SECRET_PLACEHOLDER, secret);
  if (effectiveSettings === renderedSettings) {
    throw new Error("Unified SearXNG settings did not contain the runtime secret placeholder");
  }
  await writePrivateAtomic(settingsFile, effectiveSettings);
  await chmod(secretFile, 0o600).catch(() => undefined);

  return {
    contract,
    composeFile,
    settingsFile,
    secretFile,
    preparation: "unified",
  };
}

export async function prepareLegacySearxngRuntime(
  repositoryRoot: string,
  config: EffectiveConfig,
): Promise<SearxngPreparedRuntime> {
  const root = resolve(repositoryRoot);
  const infraRoot = join(root, "infra", "searxng");
  const runtimeRoot = join(infraRoot, "runtime");
  const composeFile = join(infraRoot, "compose.yaml");
  const settingsTemplateFile = join(infraRoot, "settings.template.yml");
  const settingsFile = join(runtimeRoot, "settings.yml");
  const secretFile = join(runtimeRoot, "secret");
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  await chmod(runtimeRoot, 0o700).catch(() => undefined);
  const template = await readFile(settingsTemplateFile, "utf8");
  const secret = await readOrCreateSecret(secretFile);
  const rendered = template.replace(SEARXNG_SECRET_PLACEHOLDER, secret);
  if (rendered === template) {
    throw new Error("Legacy SearXNG settings template did not contain the runtime secret placeholder");
  }
  await writePrivateAtomic(settingsFile, rendered);
  await chmod(secretFile, 0o600).catch(() => undefined);
  return {
    contract: buildSearxngRuntimePreparationContract(config),
    composeFile,
    settingsFile,
    secretFile,
    preparation: "legacy",
  };
}

async function readOrCreateSecret(path: string): Promise<string> {
  let secret: string;
  try {
    secret = (await readFile(path, "utf8")).trim();
  } catch (error) {
    if (!isMissing(error)) throw error;
    secret = randomBytes(32).toString("hex");
    await writePrivateAtomic(path, `${secret}\n`);
  }
  if (!/^[a-f0-9]{64}$/u.test(secret)) {
    throw new Error("SearXNG runtime secret is malformed; remove infra/searxng/runtime and prepare again");
  }
  return secret;
}

async function writePrivateAtomic(path: string, content: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${String(process.pid)}-${Date.now().toString(36)}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await chmod(temporary, 0o600).catch(() => undefined);
    await rename(temporary, path);
    await chmod(path, 0o600).catch(() => undefined);
  } finally {
    await rm(temporary, { force: true });
  }
}

function fingerprintText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
