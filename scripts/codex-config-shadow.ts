import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readCodexShadowReport,
  renderCodexShadowReport,
} from "../src/config/adoption/codex-shadow-adoption.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2] ?? "show";
if (!new Set(["show", "json", "check"]).has(mode)) {
  throw new Error(`Unknown Codex shadow mode: ${mode}`);
}

const report = await readCodexShadowReport(repositoryRoot);
if (!report) {
  console.log("config.codex_shadow.status=missing");
  console.log("config.codex_shadow.instructions=restart-the-FLORAL-service-in-unified-shadow-mode");
  console.log("config.codex_shadow=missing");
  if (mode === "check") process.exitCode = 2;
} else if (mode === "json") {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(renderCodexShadowReport(report));
  if (mode === "check" && report.status !== "compatible") process.exitCode = 2;
}
