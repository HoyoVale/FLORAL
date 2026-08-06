import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { access, readFile } from "node:fs/promises";
import * as sdk from "@tencent-connect/qqbot-nodejs";

const requiredExports = [
  "QQBot",
  "FileKVStore",
  "kvSessionPersistence",
] as const;

for (const name of requiredExports) {
  if (!(name in sdk)) {
    throw new Error(`QQ SDK export missing: ${name}`);
  }
}

const qqBotPrototype = (sdk.QQBot as unknown as {
  prototype?: Record<string, unknown>;
}).prototype;

for (const method of ["start", "stop", "sendText"]) {
  if (typeof qqBotPrototype?.[method] !== "function") {
    throw new Error(`QQ SDK method missing: QQBot.prototype.${method}`);
  }
}

const version = await resolveInstalledVersion();
if (version !== "1.0.4") {
  throw new Error(`QQ SDK version drift: expected 1.0.4, received ${version}`);
}

console.log(`qq.sdk.version=${version}`);
console.log("qq.sdk.export.QQBot=ok");
console.log("qq.sdk.export.FileKVStore=ok");
console.log("qq.sdk.export.kvSessionPersistence=ok");
console.log("qq.sdk.contract=ok");

async function resolveInstalledVersion(): Promise<string> {
  const resolvedEntry = import.meta.resolve("@tencent-connect/qqbot-nodejs");
  let current = dirname(fileURLToPath(resolvedEntry));

  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(current, "package.json");
    try {
      await access(candidate);
      const parsed = JSON.parse(await readFile(candidate, "utf8")) as {
        name?: unknown;
        version?: unknown;
      };
      if (
        parsed.name === "@tencent-connect/qqbot-nodejs"
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

  throw new Error("Could not locate installed QQ SDK package.json");
}
