import { access, readFile } from "node:fs/promises";

const required = [
  "package.json", ".env.example", "AGENTS.md", "src/main.ts",
  "src/agent/codex-rpc-client.ts", "src/agent/provider/deepseek-client.ts",
  "src/agent/bridge/responses-bridge-server.ts",
  "src/transport/qq/qq-transport.ts", "src/storage/sqlite.ts",
  "src/service/gateway-commands.ts", "docs/ENVIRONMENT_SETUP.md",
  "docs/MODEL_PROVIDER_PHASE2A.md", "docs/MODEL_PROVIDER_PHASE2B.md",
  "docs/WEB_SEARCH_PHASE2B2.md", "docs/BRIDGE_RETRY_AND_CANCELLATION.md",
  "docs/PHASE3A_PERSISTENT_IDENTITY.md",
  "infra/searxng/compose.yaml",
  "infra/searxng/settings.template.yml", "src/search/searxng.ts",
  "scripts/bootstrap-macos.sh", "scripts/test-mac.ps1",
  "launchd/com.hoyo.mac-agent.plist.template"
];

for (const path of required) await access(path);
const pkg = JSON.parse(await readFile("package.json", "utf8"));
if (pkg.type !== "module") throw new Error("package.json must use ESM");
for (const script of [
  "doctor",
  "build",
  "deepseek:probe",
  "bridge:probe",
  "codex:deepseek:probe",
  "codex:deepseek:web-search:probe",
  "bridge:faults:check",
  "storage:doctor",
  "storage:probe",
  "searxng:up",
  "searxng:health",
]) {
  if (!pkg.scripts?.[script]) throw new Error(`Required script missing: ${script}`);
}
console.log(`Bootstrap structure valid (${required.length} required files).`);
