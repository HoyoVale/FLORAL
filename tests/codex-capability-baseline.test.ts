import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  analyzeCodexProtocolSchema,
  assessCodexCapabilityBaseline,
  collectCodexCapabilityBaseline,
  readCodexCapabilityBaseline,
  writeCodexCapabilityBaseline,
} from "../src/agent/codex-capability-baseline.js";

const temporary: string[] = [];
const fixturePath = fileURLToPath(
  new URL("./fixtures/fake-codex-capability-cli.mjs", import.meta.url),
);

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })
    ),
  );
});

describe("Codex capability baseline", () => {
  it("collects version-matched schema capabilities and read-only runtime constraints", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "floral-codex-capability-"));
    temporary.push(cwd);

    const report = await collectCodexCapabilityBaseline({
      command: process.execPath,
      appServerArgs: [fixturePath, "app-server"],
      requestTimeoutMs: 5_000,
      processCwd: cwd,
      processEnv: { ...process.env },
      now: new Date("2026-08-08T10:00:00.000Z"),
    });

    expect(report).toMatchObject({
      schemaVersion: 1,
      phase: "7.0",
      generatedAt: "2026-08-08T10:00:00.000Z",
      codex: {
        version: "codex-cli 9.9.9-test",
        protocolSchemaFiles: 2,
      },
      protocol: {
        threads: {
          list: true,
          read: true,
          fork: true,
          archive: true,
          delete: true,
          loadedList: true,
          turnsList: true,
        },
        config: {
          read: true,
          requirementsRead: true,
        },
        permissions: {
          profileSelection: true,
          activeProfileProjection: true,
          requestApproval: true,
          granularRequestPermissions: true,
          approvalsReviewerAutoReview: true,
          commandApprovalAcceptForSession: true,
          runtimeWorkspaceRoots: true,
        },
        instructions: {
          instructionSources: true,
        },
        memory: {
          threadMemoryModeSet: true,
          reset: true,
        },
        command: {
          exec: true,
        },
      },
      runtime: {
        initialize: {
          status: "ok",
          platformFamily: "unix",
          platformOs: "macos",
          userAgent: "fake-codex/9.9.9",
        },
        rpc: {
          configRead: { status: "ok" },
          configRequirementsRead: { status: "ok" },
          threadList: { status: "ok" },
          threadLoadedList: { status: "ok" },
        },
        effectiveConfig: {
          approvalPolicy: "untrusted",
          approvalsReviewer: "user",
          sandboxMode: "workspace-write",
        },
        requirements: {
          present: true,
          allowedApprovalPolicies: [
            "granular",
            "never",
            "on-request",
            "untrusted",
          ],
          allowedApprovalsReviewers: ["auto_review", "user"],
          allowedSandboxModes: [
            "danger-full-access",
            "read-only",
            "workspace-write",
          ],
          allowedPermissionProfiles: {
            ":read-only": true,
            ":workspace": true,
            "full-machine": false,
          },
          defaultPermissions: ":workspace",
          allowRemoteControl: false,
          autoReviewConfigured: true,
          networkRequirementsConfigured: true,
        },
      },
      readiness: {
        permissionAlignment: { status: "ready", missing: [] },
        projectChat: { status: "ready", missing: [] },
        sharedContext: { status: "ready", missing: [] },
        nativeMemory: { status: "ready", missing: [] },
      },
    });

    expect(report.codex.protocolSchemaSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(report.compatibilityFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(report.reportFingerprint).toMatch(/^[0-9a-f]{64}$/u);

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("TOP_SECRET_VALUE");
    expect(serialized).not.toContain("DO_NOT_PERSIST_THREAD_CONTENT");
    expect(serialized).not.toContain("/secret/fake-codex-home");
    expect(serialized).not.toContain("/secret/path-that-must-not-be-persisted");
  });

  it("marks missing native surfaces without inventing compatibility", () => {
    const protocol = analyzeCodexProtocolSchema(JSON.stringify({
      methods: ["thread/list", "config/read"],
      fields: ["instructionSources"],
    }));

    expect(protocol.threads.list).toBe(true);
    expect(protocol.threads.read).toBe(false);
    expect(protocol.config.read).toBe(true);
    expect(protocol.config.requirementsRead).toBe(false);
    expect(protocol.permissions.profileSelection).toBe(false);
    expect(protocol.permissions.requestApproval).toBe(false);
    expect(protocol.instructions.instructionSources).toBe(true);
    expect(protocol.memory.threadMemoryModeSet).toBe(false);
  });

  it("writes, verifies, and detects drift in the approved baseline", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "floral-codex-baseline-"));
    temporary.push(cwd);

    const report = await collectCodexCapabilityBaseline({
      command: process.execPath,
      appServerArgs: [fixturePath, "app-server"],
      requestTimeoutMs: 5_000,
      processCwd: cwd,
      processEnv: { ...process.env },
      now: new Date("2026-08-08T10:00:00.000Z"),
    });

    const path = await writeCodexCapabilityBaseline(cwd, report);
    const reloaded = await readCodexCapabilityBaseline(cwd);
    expect(reloaded).toEqual(report);
    expect(assessCodexCapabilityBaseline(report, reloaded!)).toBe("compatible");

    const tampered = JSON.parse(await readFile(path, "utf8"));
    tampered.compatibilityFingerprint = "0".repeat(64);
    await writeFile(path, `${JSON.stringify(tampered, null, 2)}\n`);

    await expect(readCodexCapabilityBaseline(cwd)).rejects.toThrow(
      "Invalid Codex capability baseline report fingerprint",
    );

    const drifted = {
      ...report,
      compatibilityFingerprint: "f".repeat(64),
    };
    expect(assessCodexCapabilityBaseline(report, drifted)).toBe("drift");
  });
});
