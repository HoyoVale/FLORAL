import { access, readFile } from "node:fs/promises";

const required = [
  "package.json", ".env.example", "vitest.config.ts", "AGENTS.md", "src/main.ts",
  "config/floral.toml", "config/catalog/upstream-config-catalog.json",
  "src/config/federation/config-authority.ts",
  "src/config/federation/config-schema.ts",
  "src/config/federation/simple-toml.ts",
  "src/config/federation/native-config-writer.ts",
  "scripts/config-native.ts",
  "src/config/adapters/native-config-types.ts",
  "src/config/adapters/native-config-bundle.ts",
  "src/config/adapters/codex-native-config.ts",
  "src/config/adapters/searxng-native-config.ts",
  "src/config/adapters/qq-sdk-native-config.ts",
  "src/config/adapters/mcp-native-config.ts",
  "src/agent/codex-rpc-client.ts", "src/agent/provider/deepseek-client.ts",
  "src/agent/bridge/responses-bridge-server.ts",
  "src/transport/qq/qq-transport.ts", "src/transport/qq/qq-text.ts",
  "src/transport/qq/reply-target-cache.ts", "src/storage/sqlite.ts",
  "src/agent/managed-codex-deepseek-runtime.ts",
  "src/service/full-chain-acceptance.ts",
  "src/service/probe-stack-guard.ts",
  "src/service/gateway-commands.ts", "docs/ENVIRONMENT_SETUP.md",
  "docs/MODEL_PROVIDER_PHASE2A.md", "docs/MODEL_PROVIDER_PHASE2B.md",
  "docs/WEB_SEARCH_PHASE2B2.md", "docs/BRIDGE_RETRY_AND_CANCELLATION.md",
  "docs/PHASE3A_PERSISTENT_IDENTITY.md", "docs/PHASE3B_QQ_PRIVATE_TRANSPORT.md",
  "docs/PHASE3B_FULL_CHAIN_ACCEPTANCE.md",
  "docs/PHASE3C_LAUNCHAGENT_SERVICE.md",
  "docs/PHASE4_CONFIG_INVENTORY.md",
  "docs/PHASE4_CONFIG_FEDERATION_CORE.md",
  "docs/PHASE4_NATIVE_CONFIG_RENDERERS.md",
  "infra/searxng/compose.yaml",
  "infra/searxng/settings.template.yml", "src/search/searxng.ts",
  "src/runtime/process-lock.ts", "src/runtime/service-state.ts",
  "src/service/launchagent-config.ts", "src/service/launchagent-runner.ts",
  "src/service/rotating-log-writer.ts", "scripts/service.ts",
  "scripts/bootstrap-macos.sh", "scripts/test-mac.ps1",
  "launchd/com.hoyo.mac-agent.plist.template"
];

for (const path of required) await access(path);
const pkg = JSON.parse(await readFile("package.json", "utf8"));
if (pkg.type !== "module") throw new Error("package.json must use ESM");
if (pkg.scripts?.start !== "node dist/src/main.js") {
  throw new Error("Production start script must use dist/src/main.js");
}
if (pkg.scripts?.test !== "vitest run --config vitest.config.ts") {
  throw new Error("Test script must use the repository-scoped Vitest config");
}
if (pkg.scripts?.["test:watch"] !== "vitest --config vitest.config.ts") {
  throw new Error("Watch test script must use the repository-scoped Vitest config");
}
for (const script of [
  "doctor",
  "build",
  "deepseek:probe",
  "bridge:probe",
  "codex:deepseek:probe",
  "codex:deepseek:web-search:probe",
  "bridge:faults:check",
  "config:inventory",
  "config:inventory:check",
  "config:validate",
  "config:show",
  "config:effective",
  "config:effective:write",
  "config:native",
  "config:native:json",
  "config:native:check",
  "config:native:write",
  "storage:doctor",
  "storage:probe",
  "qq:sdk:check",
  "qq:private:probe",
  "qq:full-chain:probe",
  "qq:reconnect:probe",
  "searxng:up",
  "searxng:health",
  "service:doctor",
  "service:install",
  "service:status",
  "service:recovery:probe",
  "service:uninstall",
]) {
  if (!pkg.scripts?.[script]) throw new Error(`Required script missing: ${script}`);
}
console.log(`Bootstrap structure valid (${required.length} required files).`);
