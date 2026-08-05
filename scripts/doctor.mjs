import { execFile } from "node:child_process";
import { promisify } from "node:util";
import process from "node:process";

const exec = promisify(execFile);

async function checkCommand({ name, command, args, required, fallback }) {
  try {
    const { stdout, stderr } = await exec(command, args, { timeout: 10_000 });
    console.log(`✓ ${name}: ${(stdout || stderr).trim().split("\n")[0]}`);
    return true;
  } catch {
    if (fallback) {
      try {
        const { stdout, stderr } = await exec(fallback.command, fallback.args, {
          timeout: 10_000,
        });
        console.log(`✓ ${name}: ${(stdout || stderr).trim().split("\n")[0]} (${fallback.label})`);
        return true;
      } catch {
        // Continue to the standard missing-command report below.
      }
    }

    console.log(
      `${required ? "✗" : "○"} ${name}: not available${required ? " (required)" : " (optional for current mode)"}`,
    );
    return !required;
  }
}

const checks = [
  { name: "node", command: "node", args: ["--version"], required: true },
  {
    name: "pnpm",
    command: "pnpm",
    args: ["--version"],
    required: false,
    fallback: {
      command: "corepack",
      args: ["pnpm", "--version"],
      label: "via corepack",
    },
  },
  { name: "git", command: "git", args: ["--version"], required: true },
  { name: "tailscale", command: "tailscale", args: ["version"], required: false },
  { name: "codex", command: "codex", args: ["--version"], required: false },
  ...(process.platform === "darwin"
    ? [{ name: "peekaboo", command: "peekaboo", args: ["--version"], required: false }]
    : []),
];

let failedRequired = false;
for (const check of checks) {
  const passed = await checkCommand(check);
  if (!passed && check.required) failedRequired = true;
}

console.log(`platform=${process.platform} arch=${process.arch} node=${process.version}`);
if (failedRequired) process.exitCode = 1;
