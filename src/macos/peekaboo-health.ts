import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function checkPeekaboo(command = "peekaboo"): Promise<{ ok: boolean; detail: string }> {
  if (process.platform !== "darwin") {
    return { ok: false, detail: "Peekaboo is macOS-only; use mock mode on this platform." };
  }

  try {
    const { stdout, stderr } = await execFileAsync(command, ["--version"], { timeout: 10_000 });
    return { ok: true, detail: (stdout || stderr).trim() || "Peekaboo available" };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}
