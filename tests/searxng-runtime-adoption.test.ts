import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assessSearxngRuntimeAdoptionReport,
  createSearxngRuntimeAdoptionReport,
  readSearxngRuntimeAdoptionReport,
  writeSearxngRuntimeAdoptionReport,
} from "../src/config/adoption/searxng-runtime-preparation-adoption.js";
import { resolveConfigurationAuthority } from "../src/config/federation/config-authority.js";
import { buildSearxngRuntimePreparationContract } from "../src/config/search/searxng-runtime-preparation.js";
import type { SearxngRuntimeObservation } from "../src/search/searxng-runtime-observation.js";

const repositoryRoot = resolve(".");

function observation(fingerprint = "a".repeat(64)): SearxngRuntimeObservation {
  return {
    endpoint: "http://127.0.0.1:8888/config",
    status: "observed",
    topLevelKeys: ["categories", "engines", "plugins"],
    engines: ["bing", "google"],
    plugins: ["Hash plugin"],
    categories: ["general"],
    fingerprint,
  };
}

describe("SearXNG runtime adoption report", () => {
  it("assesses an active report only for the current runtime and observed /config", async () => {
    const authority = await resolveConfigurationAuthority({ repositoryRoot, environment: {} });
    const contract = buildSearxngRuntimePreparationContract(authority.effective);
    const currentObservation = observation();
    const report = createSearxngRuntimeAdoptionReport({
      status: "active",
      activePreparation: "unified",
      effectiveFingerprint: authority.effectiveFingerprint,
      target: contract,
      active: contract,
      observation: currentObservation,
      fallbackUsed: false,
      reasonCode: "unified-observed",
      now: new Date("2026-08-07T00:00:00.000Z"),
    });
    expect(assessSearxngRuntimeAdoptionReport(report, contract, currentObservation)).toBe("active");
    expect(assessSearxngRuntimeAdoptionReport(report, contract, observation("b".repeat(64)))).toBe("drift");
  });

  it("persists a private tamper-evident report without runtime secrets", async () => {
    const root = await mkdtemp(join(tmpdir(), "floral-searxng-adoption-"));
    const authority = await resolveConfigurationAuthority({ repositoryRoot, environment: {} });
    const contract = buildSearxngRuntimePreparationContract(authority.effective);
    const report = createSearxngRuntimeAdoptionReport({
      status: "active",
      activePreparation: "unified",
      effectiveFingerprint: authority.effectiveFingerprint,
      target: contract,
      active: contract,
      observation: observation(),
      fallbackUsed: false,
      reasonCode: "unified-observed",
    });
    const path = await writeSearxngRuntimeAdoptionReport(root, report);
    expect(await readSearxngRuntimeAdoptionReport(root)).toEqual(report);
    expect(JSON.stringify(report)).not.toContain("secret_key");
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("records legacy recovery as blocked rather than active", async () => {
    const authority = await resolveConfigurationAuthority({ repositoryRoot, environment: {} });
    const contract = buildSearxngRuntimePreparationContract(authority.effective);
    const report = createSearxngRuntimeAdoptionReport({
      status: "rolled-back",
      activePreparation: "legacy",
      effectiveFingerprint: authority.effectiveFingerprint,
      target: contract,
      active: contract,
      observation: observation(),
      fallbackUsed: true,
      reasonCode: "unified-failed-legacy-recovered",
      startupError: new Error("synthetic unified failure"),
    });
    expect(assessSearxngRuntimeAdoptionReport(report, contract, observation())).toBe("rolled-back");
    expect(report.startupErrorType).toBe("Error");
  });
});
