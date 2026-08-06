import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseCodexCompatibilityCaptureArtifact,
  parseCodexCompatibilityFixture,
  verifyCapturedCodexRequest,
  verifyCodexCompatibilityFixture,
} from "../src/agent/bridge/responses-compat.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = join(repositoryRoot, "tests", "fixtures", "codex-responses");
const capturePath = readCapturePath(process.argv.slice(2));

try {
  const files = (await readdir(fixtureRoot))
    .filter((name) => name.endsWith(".json"))
    .sort();
  if (files.length === 0) {
    throw new Error(`No Codex compatibility fixtures found in ${fixtureRoot}`);
  }

  for (const file of files) {
    const fixture = parseCodexCompatibilityFixture(
      JSON.parse(await readFile(join(fixtureRoot, file), "utf8")) as unknown,
    );
    verifyCodexCompatibilityFixture(fixture);
    console.log(`codex.compat.fixture.${fixture.name}=ok`);
  }
  console.log(`codex.compat.fixtures=${files.length}`);

  if (capturePath) {
    const absoluteCapturePath = resolve(repositoryRoot, capturePath);
    const artifact = parseCodexCompatibilityCaptureArtifact(
      JSON.parse(await readFile(absoluteCapturePath, "utf8")) as unknown,
    );
    for (const request of artifact.requests) {
      verifyCapturedCodexRequest(request);
    }
    console.log(`codex.compat.capture.requests=${artifact.requests.length}`);
    console.log(`codex.compat.capture.file=${absoluteCapturePath}`);
  }

  console.log("codex.compat.result=ok");
} catch (error) {
  console.error(`codex.compat.error=${error instanceof Error ? error.message : String(error)}`);
  console.log("codex.compat.result=failed");
  process.exitCode = 1;
}

function readCapturePath(args: string[]): string | undefined {
  const index = args.indexOf("--capture");
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value) throw new Error("--capture requires a file path");
  return value;
}
