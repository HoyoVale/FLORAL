import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const QQ_SDK_PACKAGE = "@tencent-connect/qqbot-nodejs";

export async function resolveInstalledQqSdkVersion(): Promise<string> {
  const resolvedEntry = import.meta.resolve(QQ_SDK_PACKAGE);
  let current = dirname(fileURLToPath(resolvedEntry));

  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(current, "package.json");
    try {
      await access(candidate);
      const parsed = JSON.parse(await readFile(candidate, "utf8")) as {
        name?: unknown;
        version?: unknown;
      };
      if (parsed.name === QQ_SDK_PACKAGE && typeof parsed.version === "string") {
        return parsed.version;
      }
    } catch {
      // Continue walking toward the package root.
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  throw new Error("Could not locate installed QQ SDK package.json");
}

export async function assertInstalledQqSdkVersion(expectedVersion: string): Promise<string> {
  const installedVersion = await resolveInstalledQqSdkVersion();
  if (installedVersion !== expectedVersion) {
    throw new Error("Installed QQ SDK version does not match the reviewed configuration");
  }
  return installedVersion;
}
