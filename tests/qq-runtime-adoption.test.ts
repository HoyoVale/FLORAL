import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assessQqRuntimeAdoptionReport,
  createQqRuntimeAdoptionReport,
  readQqRuntimeAdoptionReport,
  writeQqRuntimeAdoptionReport,
  type QqRuntimeAdoptionReport,
} from "../src/config/adoption/qq-runtime-options-adoption.js";
import { loadEnv } from "../src/config/env.js";
import { resolveConfigurationAuthority } from "../src/config/federation/config-authority.js";
import {
  buildLegacyQqRuntimeOptionsContract,
  buildQqRuntimeOptionsContract,
} from "../src/config/qq/qq-runtime-options.js";
import type { ChatTransport } from "../src/core/contracts.js";
import type { IncomingMessage, OutgoingMessage } from "../src/core/types.js";
import { QqRuntimeAdoptionTransport } from "../src/transport/qq/qq-runtime-adoption-transport.js";

const repositoryRoot = resolve(".");
const environment: NodeJS.ProcessEnv = {
  QQ_MODE: "real",
  QQBOT_APP_ID: "app-id",
  QQBOT_APP_SECRET: "app-secret",
  OWNER_PAIRING_CODE: "owner-pairing-code",
  DEEPSEEK_API_KEY: "deepseek-key",
};

class FakeTransport implements ChatTransport {
  readonly name = "fake-qq";
  started = false;
  stopped = false;
  constructor(private readonly startError?: Error) {}
  async start(_onMessage: (message: IncomingMessage) => Promise<void>): Promise<void> {
    if (this.startError) throw this.startError;
    this.started = true;
  }
  async send(_message: OutgoingMessage): Promise<void> {}
  async stop(): Promise<void> { this.stopped = true; }
}

describe("QQ runtime options adoption", () => {
  it("activates unified runtime options and records a current report", async () => {
    const authority = await resolveConfigurationAuthority({ repositoryRoot, environment });
    const env = loadEnv(environment);
    let report: QqRuntimeAdoptionReport | undefined;
    const transport = new QqRuntimeAdoptionTransport(
      repositoryRoot,
      authority,
      env,
      environment,
      {
        createTransport: () => new FakeTransport(),
        resolveInstalledSdkVersion: async () => "1.0.4",
        clearReport: async () => undefined,
        recordReport: async (value) => { report = value; return "/tmp/qq-runtime.json"; },
      },
    );
    await transport.start(async () => undefined);
    expect(report?.status).toBe("active");
    expect(report?.activeOptions).toBe("unified");
    expect(report && assessQqRuntimeAdoptionReport(
      report,
      buildQqRuntimeOptionsContract(authority.effective),
      "1.0.4",
    )).toBe("active");
    await transport.stop();
  });

  it("recovers with legacy options after unified startup failure", async () => {
    const authority = await resolveConfigurationAuthority({ repositoryRoot, environment });
    const env = loadEnv(environment);
    let calls = 0;
    let report: QqRuntimeAdoptionReport | undefined;
    const transport = new QqRuntimeAdoptionTransport(
      repositoryRoot,
      authority,
      env,
      environment,
      {
        createTransport: () => new FakeTransport(calls++ === 0 ? new Error("unified") : undefined),
        resolveInstalledSdkVersion: async () => "1.0.4",
        clearReport: async () => undefined,
        recordReport: async (value) => { report = value; return "/tmp/qq-runtime.json"; },
      },
    );
    await transport.start(async () => undefined);
    expect(calls).toBe(2);
    expect(report?.status).toBe("rolled-back");
    expect(report?.activeRuntimeFingerprint).toBe(
      buildLegacyQqRuntimeOptionsContract(env).runtimeFingerprint,
    );
    await transport.stop();
  });

  it("rolls back when unified startup succeeds but adoption evidence cannot be written", async () => {
    const authority = await resolveConfigurationAuthority({ repositoryRoot, environment });
    const env = loadEnv(environment);
    let transports = 0;
    let reportWrites = 0;
    let report: QqRuntimeAdoptionReport | undefined;
    const created: FakeTransport[] = [];
    const transport = new QqRuntimeAdoptionTransport(
      repositoryRoot,
      authority,
      env,
      environment,
      {
        createTransport: () => {
          transports += 1;
          const createdTransport = new FakeTransport();
          created.push(createdTransport);
          return createdTransport;
        },
        resolveInstalledSdkVersion: async () => "1.0.4",
        clearReport: async () => undefined,
        recordReport: async (value) => {
          reportWrites += 1;
          if (reportWrites === 1) throw new Error("report unavailable");
          report = value;
          return "/tmp/qq-runtime.json";
        },
      },
    );
    await transport.start(async () => undefined);
    expect(transports).toBe(2);
    expect(created[0]?.stopped).toBe(true);
    expect(report?.status).toBe("rolled-back");
    expect(report?.startupErrorType).toBe("Error");
    await transport.stop();
  });

  it("writes a private tamper-evident adoption report", async () => {
    const authority = await resolveConfigurationAuthority({ repositoryRoot, environment });
    const env = loadEnv(environment);
    const unified = buildQqRuntimeOptionsContract(authority.effective);
    const report = createQqRuntimeAdoptionReport({
      status: "active",
      activeOptions: "unified",
      effectiveFingerprint: authority.effectiveFingerprint,
      unified,
      legacy: buildLegacyQqRuntimeOptionsContract(env),
      installedSdkVersion: "1.0.4",
      fallbackUsed: false,
      reasonCode: "unified-ready",
      now: new Date("2026-08-07T00:00:00.000Z"),
    });
    const root = await mkdtemp(join(tmpdir(), "floral-qq-adoption-"));
    await chmod(root, 0o700);
    const path = await writeQqRuntimeAdoptionReport(root, report);
    expect(await readQqRuntimeAdoptionReport(root)).toEqual(report);
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
    const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    parsed.status = "rolled-back";
    await writeFile(path, `${JSON.stringify(parsed)}\n`, "utf8");
    await expect(readQqRuntimeAdoptionReport(root)).rejects.toThrow(/fingerprint|Invalid/u);
  });
});
