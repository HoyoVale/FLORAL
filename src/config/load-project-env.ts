import { loadEnvFile } from "node:process";

export function loadProjectEnv(path = ".env"): void {
  try {
    loadEnvFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}
