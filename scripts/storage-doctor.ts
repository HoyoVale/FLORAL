import { resolve } from "node:path";
import { loadEnv } from "../src/config/env.js";
import { loadProjectEnv } from "../src/config/load-project-env.js";
import { SqliteGatewayStore } from "../src/storage/sqlite.js";

loadProjectEnv();
const env = loadEnv();
const path = resolve(env.DATABASE_PATH);
const store = await SqliteGatewayStore.open(path);

try {
  const diagnostics = store.diagnostics();
  console.log(`storage.path=${path}`);
  console.log(`storage.schema_version=${diagnostics.schemaVersion}`);
  console.log(`storage.users=${diagnostics.users}`);
  console.log(`storage.identities=${diagnostics.identities}`);
  console.log(`storage.conversations=${diagnostics.conversations}`);
  console.log(`storage.conversation_projects=${diagnostics.conversationProjects}`);
  console.log(`storage.message_receipts=${diagnostics.messageReceipts}`);
  console.log(`storage.audit_events=${diagnostics.auditEvents}`);
  console.log(`storage.owners=${diagnostics.owners}`);
  console.log("storage.doctor=ok");
} finally {
  await store.close();
}
