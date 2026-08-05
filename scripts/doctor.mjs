import { execFile } from "node:child_process";
import { promisify } from "node:util";
import process from "node:process";

const exec = promisify(execFile);
const checks = [
  ["node", ["--version"], true],
  ["pnpm", ["--version"], false],
  ["git", ["--version"], true],
  ["tailscale", ["version"], false],
  ["codex", ["--version"], false],
  ...(process.platform === "darwin" ? [["peekaboo", ["--version"], false]] : [])
];

let failedRequired = false;
for (const [command, args, required] of checks) {
  try {
    const { stdout, stderr } = await exec(command, args, { timeout: 10_000 });
    console.log(`✓ ${command}: ${(stdout || stderr).trim().split("\n")[0]}`);
  } catch {
    console.log(`${required ? "✗" : "○"} ${command}: not available${required ? " (required)" : " (optional for current mode)"}`);
    if (required) failedRequired = true;
  }
}
console.log(`platform=${process.platform} arch=${process.arch} node=${process.version}`);
if (failedRequired) process.exitCode = 1;
