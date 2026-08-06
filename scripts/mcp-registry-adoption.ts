import {
  assessMcpRegistryAdoptionReport,
  readMcpRegistryAdoptionReport,
  renderMcpRegistryAdoptionReport,
} from "../src/config/adoption/mcp-registry-adoption.js";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderCodexConfig } from "../src/config/adapters/codex-native-config.js";
import { resolveConfigurationAuthority } from "../src/config/federation/config-authority.js";
import { buildMcpRuntimeRegistry } from "../src/config/mcp/mcp-runtime-registry.js";
import { loadProjectEnv } from "../src/config/load-project-env.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadProjectEnv(join(repositoryRoot, ".env"));
const command = process.argv[2] ?? "show";
if (!["show", "json", "check"].includes(command)) {
  throw new Error(`Unsupported MCP registry adoption command: ${command}`);
}

const authority = await resolveConfigurationAuthority({
  repositoryRoot,
  environment: process.env,
});
const registry = buildMcpRuntimeRegistry(authority.effective);
let report: Awaited<ReturnType<typeof readMcpRegistryAdoptionReport>>;
let invalid = false;
try {
  report = await readMcpRegistryAdoptionReport(repositoryRoot);
} catch {
  invalid = true;
}
const required = authority.effective.codex.mode === "real"
  && authority.effective.runtime.adoption.codex.mode === "unified";
const currentStatus = !required
  ? "disabled"
  : invalid
    ? "invalid"
    : !report
      ? "missing"
      : assessMcpRegistryAdoptionReport(
        report,
        registry,
        renderCodexConfig(authority.effective, undefined, registry),
      );

if (command === "json") {
  process.stdout.write(`${JSON.stringify({
    required,
    currentStatus,
    registryFingerprint: registry.registryFingerprint,
    report: report ?? null,
  }, null, 2)}\n`);
} else if (report) {
  process.stdout.write(renderMcpRegistryAdoptionReport(report));
  process.stdout.write(`config.mcp_adoption.current_registry_fingerprint=${registry.registryFingerprint}\n`);
  process.stdout.write(`config.mcp_adoption.current_status=${currentStatus}\n`);
} else {
  process.stdout.write(`config.mcp_adoption.required=${String(required)}\n`);
  process.stdout.write(`config.mcp_adoption.current_registry_fingerprint=${registry.registryFingerprint}\n`);
  process.stdout.write(`config.mcp_adoption.current_status=${currentStatus}\n`);
}

if (command === "check" && required && currentStatus !== "active") {
  process.exitCode = 2;
}
