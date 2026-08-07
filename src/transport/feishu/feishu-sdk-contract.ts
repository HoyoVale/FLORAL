import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export async function assertInstalledFeishuSdkVersion(
  expectedVersion: string,
): Promise<string> {
  if (!expectedVersion.trim()) throw new Error("Feishu SDK expected version is required");
  const version = await resolveInstalledFeishuSdkVersion();
  if (version !== expectedVersion) {
    throw new Error(
      `Feishu SDK version drift: expected ${expectedVersion}, received ${version}`,
    );
  }
  return version;
}

export async function resolveInstalledFeishuSdkVersion(): Promise<string> {
  const resolvedEntry = import.meta.resolve("@larksuiteoapi/node-sdk");
  let current = dirname(fileURLToPath(resolvedEntry));

  for (let depth = 0; depth < 10; depth += 1) {
    const candidate = join(current, "package.json");
    try {
      await access(candidate);
      const parsed = JSON.parse(await readFile(candidate, "utf8")) as {
        name?: unknown;
        version?: unknown;
      };
      if (
        parsed.name === "@larksuiteoapi/node-sdk"
        && typeof parsed.version === "string"
      ) {
        return parsed.version;
      }
    } catch {
      // Continue walking toward the package root.
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  throw new Error("Could not locate installed Feishu SDK package.json");
}
