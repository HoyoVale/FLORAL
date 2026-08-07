import { randomBytes } from "node:crypto";
import { createResponsesBridge } from "../src/agent/bridge/bridge-factory.js";
import { loadEnv } from "../src/config/env.js";
import { loadProjectEnv } from "../src/config/load-project-env.js";
import { createProjectDeepSeekCostGuard } from "../src/runtime/cost/cost-guard-factory.js";

loadProjectEnv();
const env = loadEnv();
const costGuard = await createProjectDeepSeekCostGuard(process.cwd(), process.env);
const token = randomBytes(32).toString("hex");
const bridge = createResponsesBridge(env, token, 0, { costGuard });
const address = await bridge.start();

console.log("probe.bridge=floral-responses-bridge");
console.log(`probe.bridge_url=${address.baseUrl}`);
console.log(`probe.model=${env.DEEPSEEK_MODEL}`);

try {
  const response = await fetch(`${address.baseUrl}/responses`, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${token}`,
      "content-type": "application/json",
      "accept": "text/event-stream",
    },
    body: JSON.stringify({
      model: env.DEEPSEEK_MODEL,
      instructions: "Follow the user's output constraint exactly.",
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Reply with exactly: FLORAL_BRIDGE_OK" }],
      }],
      stream: true,
    }),
  });

  if (!response.ok || !response.body) {
    throw new Error(`Bridge probe HTTP ${response.status}: ${await response.text()}`);
  }

  const events = await readResponseEvents(response.body);
  const text = events
    .filter((event) => event.type === "response.output_text.delta")
    .map((event) => typeof event.delta === "string" ? event.delta : "")
    .join("")
    .trim();

  console.log(`probe.text=${JSON.stringify(text)}`);
  console.log(`probe.completed=${events.some((event) => event.type === "response.completed")}`);

  if (text !== "FLORAL_BRIDGE_OK") {
    console.log("probe.result=unexpected-output");
    process.exitCode = 1;
  } else if (!events.some((event) => event.type === "response.completed")) {
    console.log("probe.result=missing-completion");
    process.exitCode = 1;
  } else {
    console.log("probe.result=ok");
  }
} catch (error) {
  console.log(`probe.error=${error instanceof Error ? error.message : String(error)}`);
  console.log("probe.result=failed");
  process.exitCode = 1;
} finally {
  await bridge.stop();
}

async function readResponseEvents(
  stream: ReadableStream<Uint8Array>,
): Promise<Record<string, unknown>[]> {
  const text = await new Response(stream).text();
  const events: Record<string, unknown>[] = [];
  for (const frame of text.replace(/\r\n/g, "\n").split("\n\n")) {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    const parsed = JSON.parse(data) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      events.push(parsed as Record<string, unknown>);
    }
  }
  return events;
}
