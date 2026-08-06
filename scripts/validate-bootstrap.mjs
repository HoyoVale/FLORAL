import { access, readFile } from "node:fs/promises";

const required = [
  "package.json", ".env.example", "AGENTS.md", "src/main.ts",
  "src/agent/codex-rpc-client.ts", "src/agent/provider/deepseek-client.ts",
  "src/agent/bridge/responses-bridge-server.ts",
  "src/transport/qq/qq-transport.ts", "docs/ENVIRONMENT_SETUP.md",
  "docs/MODEL_PROVIDER_PHASE2A.md", "docs/MODEL_PROVIDER_PHASE2B.md",
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
]) {
  if (!pkg.scripts?.[script]) throw new Error(`Required script missing: ${script}`);
}
console.log(`Bootstrap structure valid (${required.length} required files).`);
