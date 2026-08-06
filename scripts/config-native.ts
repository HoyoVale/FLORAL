import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  renderNativeConfigBundle,
  renderNativeConfigSummary,
  safeNativeBundleJson,
} from "../src/config/adapters/native-config-bundle.js";
import { resolveConfigurationAuthority } from "../src/config/federation/config-authority.js";
import { normalizeNativeConfigText } from "../src/config/adapters/native-config-types.js";
import { writeNativeConfigBundle } from "../src/config/federation/native-config-writer.js";
import { loadProjectEnv } from "../src/config/load-project-env.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadProjectEnv(join(repositoryRoot, ".env"));

const args = process.argv.slice(2);
const mode = args[0] ?? "show";
const supportedModes = new Set(["show", "json", "write", "check"]);
if (!supportedModes.has(mode)) throw new Error(`Unknown native config mode: ${mode}`);

const configFlagIndex = args.indexOf("--config");
const configPath = configFlagIndex >= 0 ? args[configFlagIndex + 1] : undefined;
if (configFlagIndex >= 0 && !configPath) throw new Error("--config requires a path");
const unknownArguments = args.filter((argument, index) => (
  index !== 0
  && argument !== "--config"
  && index !== configFlagIndex + 1
));
if (unknownArguments.length > 0) {
  throw new Error(`Unknown native config arguments: ${unknownArguments.join(", ")}`);
}

const authority = await resolveConfigurationAuthority({
  repositoryRoot,
  ...(configPath ? { configPath } : {}),
  environment: process.env,
});
const bundle = renderNativeConfigBundle(authority);

if (mode === "json") {
  process.stdout.write(`${JSON.stringify(safeNativeBundleJson(bundle), null, 2)}\n`);
} else if (mode === "write") {
  const paths = await writeNativeConfigBundle(repositoryRoot, bundle);
  process.stdout.write(renderNativeConfigSummary(bundle));
  console.log(`config.native.directory=${paths.directory}`);
  console.log("config.native.write=ok");
} else if (mode === "check") {
  await validateNativeConfigBundle(bundle);
  process.stdout.write(renderNativeConfigSummary(bundle));
  console.log("config.native.check=ok");
} else {
  process.stdout.write(renderNativeConfigSummary(bundle));
}

async function validateNativeConfigBundle(
  bundle: ReturnType<typeof renderNativeConfigBundle>,
): Promise<void> {
  const rerendered = renderNativeConfigBundle(authority);
  if (rerendered.bundleFingerprint !== bundle.bundleFingerprint) {
    throw new Error("Native configuration rendering is not deterministic");
  }

  const paths = bundle.artifacts.map((artifact) => artifact.relativePath);
  if (new Set(paths).size !== paths.length) {
    throw new Error("Native configuration artifact paths must be unique");
  }

  for (const [artifactPath, checkedInPath] of [
    ["searxng/settings.yml", "infra/searxng/settings.template.yml"],
    ["searxng/compose.yaml", "infra/searxng/compose.yaml"],
  ] as const) {
    const rendered = requireArtifact(bundle, artifactPath).content;
    const checkedIn = await readFile(join(repositoryRoot, checkedInPath), "utf8");
    if (normalizeNativeConfigText(rendered) !== normalizeNativeConfigText(checkedIn)) {
      throw new Error(`${checkedInPath} drifted from the unified SearXNG renderer`);
    }
  }

  const pkg = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")) as {
    dependencies?: Record<string, string> | undefined;
  };
  const configuredVersion = authority.effective.qq.sdk.expected_version;
  if (pkg.dependencies?.["@tencent-connect/qqbot-nodejs"] !== configuredVersion) {
    throw new Error(
      `QQ SDK config drift: expected ${configuredVersion}, package.json has ${String(pkg.dependencies?.["@tencent-connect/qqbot-nodejs"])}`,
    );
  }

  const forbiddenValues = [
    process.env.DEEPSEEK_API_KEY,
    process.env.QQBOT_APP_ID,
    process.env.QQBOT_APP_SECRET,
    process.env.OWNER_PAIRING_CODE,
    process.env.BETTER_AUTH_SECRET,
    process.env.FLORAL_BRIDGE_TOKEN,
  ].filter((value): value is string => typeof value === "string" && value.length >= 12);
  for (const artifact of bundle.artifacts) {
    for (const secret of forbiddenValues) {
      if (artifact.content.includes(secret)) {
        throw new Error(`Native artifact leaked a secret value: ${artifact.relativePath}`);
      }
    }
  }
}

function requireArtifact(
  bundle: ReturnType<typeof renderNativeConfigBundle>,
  relativePath: string,
) {
  const artifact = bundle.artifacts.find((entry) => entry.relativePath === relativePath);
  if (!artifact) throw new Error(`Native artifact missing: ${relativePath}`);
  return artifact;
}
