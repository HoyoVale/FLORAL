import { access, readFile } from "node:fs/promises";

const required = [
  "package.json", ".env.example", "AGENTS.md", "src/main.ts",
  "src/agent/codex-rpc-client.ts", "src/agent/provider/deepseek-client.ts",
  "src/transport/qq/qq-transport.ts", "docs/ENVIRONMENT_SETUP.md",
  "docs/MODEL_PROVIDER_PHASE2A.md", "scripts/bootstrap-macos.sh",
  "scripts/test-mac.ps1", "launchd/com.hoyo.mac-agent.plist.template"
];

for (const path of required) await access(path);
const pkg = JSON.parse(await readFile("package.json", "utf8"));
if (pkg.type !== "module") throw new Error("package.json must use ESM");
if (!pkg.scripts?.doctor || !pkg.scripts?.build || !pkg.scripts?.["deepseek:probe"]) {
  throw new Error("Required scripts missing");
}
console.log(`Bootstrap structure valid (${required.length} required files).`);
