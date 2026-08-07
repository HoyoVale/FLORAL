import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as sdk from "@larksuiteoapi/node-sdk";

const EXPECTED_VERSION = "1.36.0";

for (const name of ["Client", "WSClient", "EventDispatcher"] as const) {
  if (!(name in sdk)) {
    throw new Error(`Feishu SDK export missing: ${name}`);
  }
}

const wsPrototype = (sdk.WSClient as unknown as {
  prototype?: Record<string, unknown>;
}).prototype;
if (typeof wsPrototype?.start !== "function") {
  throw new Error("Feishu SDK method missing: WSClient.prototype.start");
}

const dispatcherPrototype = (sdk.EventDispatcher as unknown as {
  prototype?: Record<string, unknown>;
}).prototype;
if (typeof dispatcherPrototype?.register !== "function") {
  throw new Error("Feishu SDK method missing: EventDispatcher.prototype.register");
}

const client = new sdk.Client({
  appId: "cli_contract_probe",
  appSecret: "contract-probe-secret",
});
if (typeof client.im?.v1?.message?.create !== "function") {
  throw new Error("Feishu SDK method missing: Client.im.v1.message.create");
}
if (typeof client.im?.v1?.image?.create !== "function") {
  throw new Error("Feishu SDK method missing: Client.im.v1.image.create");
}
if (typeof client.im?.v1?.file?.create !== "function") {
  throw new Error("Feishu SDK method missing: Client.im.v1.file.create");
}

const version = await resolveInstalledVersion();
if (version !== EXPECTED_VERSION) {
  throw new Error(
    `Feishu SDK version drift: expected ${EXPECTED_VERSION}, received ${version}`,
  );
}

console.log(`feishu.sdk.version=${version}`);
console.log("feishu.sdk.export.Client=ok");
console.log("feishu.sdk.export.WSClient=ok");
console.log("feishu.sdk.export.EventDispatcher=ok");
console.log("feishu.sdk.method.WSClient.start=ok");
console.log("feishu.sdk.method.im.v1.message.create=ok");
console.log("feishu.sdk.method.im.v1.image.create=ok");
console.log("feishu.sdk.method.im.v1.file.create=ok");
console.log("feishu.sdk.contract=ok");

async function resolveInstalledVersion(): Promise<string> {
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
