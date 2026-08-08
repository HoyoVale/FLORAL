import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assessCodexShadowReport,
  fingerprintCodexConfigSemantics,
  readCodexShadowReport,
  renderCodexShadowReport,
} from "../src/config/adoption/codex-shadow-adoption.js";
import { renderCodexConfig } from "../src/config/adapters/codex-native-config.js";
import { resolveConfigurationAuthority } from "../src/config/federation/config-authority.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2] ?? "show";
if (!new Set(["show", "json", "check"]).has(mode)) {
  throw new Error(`Unknown Codex shadow mode: ${mode}`);
}

const report = await readCodexShadowReport(repositoryRoot);
if (!report) {
  console.log("config.codex_shadow.status=missing");
  console.log("config.codex_shadow.instructions=restart-the-FLORAL-service-to-refresh-compatible-shadow");
  console.log("config.codex_shadow=missing");
  if (mode === "check") process.exitCode = 2;
} else if (mode === "json") {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  const authority = await resolveConfigurationAuthority({
    repositoryRoot,
    environment: process.env,
  });
  const currentUnifiedConfig = renderCodexConfig(authority.effective);
  const currentCodexConfigFingerprint = fingerprintCodexConfigSemantics(currentUnifiedConfig);
  const currentStatus = assessCodexShadowReport(report, currentUnifiedConfig);
  process.stdout.write(renderCodexShadowReport(report));
  console.log(`config.codex_shadow.current_codex_config_fingerprint=${currentCodexConfigFingerprint}`);
  console.log(`config.codex_shadow.current_status=${currentStatus}`);
  if (mode === "check" && currentStatus !== "compatible") process.exitCode = 2;
}
