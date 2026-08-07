import { join, resolve } from "node:path";
import { resolveLaunchAgentUserPaths } from "../service/launchagent-paths.js";

export function resolveLocalConfirmationDirectory(
  homeDir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "darwin") {
    return join(resolveLaunchAgentUserPaths(homeDir).runtimeDir, "local-approvals");
  }
  return join(resolve(homeDir), ".floral", "runtime", "local-approvals");
}
