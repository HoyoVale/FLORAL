import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assessCodexCutoverReport,
  readCodexCutoverReport,
  renderCodexCutoverReport,
} from "../src/config/adoption/codex-controlled-cutover.js";
import { renderCodexConfig } from "../src/config/adapters/codex-native-config.js";
import { resolveConfigurationAuthority } from "../src/config/federation/config-authority.js";
import { loadProjectEnv } from "../src/config/load-project-env.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadProjectEnv(resolve(repositoryRoot, ".env"));
const mode = process.argv[2] ?? "show";
if (!new Set(["show", "json", "check"]).has(mode)) {
  throw new Error(`Unknown Codex cutover mode: ${mode}`);
}

const report = await readCodexCutoverReport(repositoryRoot);
if (!report) {
  console.log("config.codex_cutover.status=missing");
  console.log("config.codex_cutover.instructions=restart-the-FLORAL-service-in-unified-mode");
  console.log("config.codex_cutover=missing");
  if (mode === "check") process.exitCode = 2;
} else if (mode === "json") {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  const authority = await resolveConfigurationAuthority({
    repositoryRoot,
    environment: process.env,
  });
  const currentStatus = assessCodexCutoverReport(
    report,
    renderCodexConfig(authority.effective),
  );
  process.stdout.write(renderCodexCutoverReport(report));
  console.log(`config.codex_cutover.current_status=${currentStatus}`);
  if (mode === "check" && currentStatus !== "active") process.exitCode = 2;
}
