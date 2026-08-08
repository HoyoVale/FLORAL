import Database from "better-sqlite3";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  fingerprintNativeMemoryError,
  readCodexNativeMemoryPhase2Forensics,
  redactNativeMemoryErrorExcerpt,
  renderCodexNativeMemoryPhase2ForensicLines,
} from "../src/agent/codex-native-memory-forensics.js";

describe("Codex native memory Phase 2 local forensics", () => {
  it("reads the Phase 2 error through a read-only database and emits only a redacted bounded excerpt", async () => {
    const home = await mkdtemp(join(tmpdir(), "floral-memory-forensics-"));
    try {
      await mkdir(join(home, "memories"), { recursive: true });
      const db = new Database(join(home, "memories_1.sqlite"));
      db.exec(`
        CREATE TABLE jobs (
          kind TEXT NOT NULL,
          job_key TEXT NOT NULL,
          status TEXT NOT NULL,
          retry_remaining INTEGER,
          attempts INTEGER,
          created_at TEXT,
          updated_at TEXT,
          next_retry_at TEXT,
          last_error TEXT
        );
      `);
      db.prepare(`
        INSERT INTO jobs(
          kind, job_key, status, retry_remaining, attempts,
          created_at, updated_at, next_retry_at, last_error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "memory_consolidate_global",
        "global",
        "error",
        2,
        1,
        "2026-08-08T16:47:00Z",
        "2026-08-08T16:47:37Z",
        "2026-08-08T16:57:37Z",
        "provider failed at https://secret.example/v1 with Bearer super-secret and /Users/alice/private/file",
      );
      db.close();

      const result = await readCodexNativeMemoryPhase2Forensics({ managedHome: home });
      expect(result).toMatchObject({
        database: "read-only",
        databaseFile: "memories_1.sqlite",
        status: "error",
        retryRemaining: 2,
        attempts: 1,
        errorPresent: true,
      });
      expect(result.errorExcerpt).toContain("<redacted-url>");
      expect(result.errorExcerpt).toContain("Bearer <redacted>");
      expect(result.errorExcerpt).toContain("$HOME/private/file");
      expect(result.errorExcerpt).not.toContain("super-secret");
      expect(result.errorFingerprint).toMatch(/^sha256:[a-f0-9]{16}$/u);
      expect(renderCodexNativeMemoryPhase2ForensicLines(result).join("\n"))
        .not.toContain("secret.example");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("aggressively redacts common secret and identity-bearing error fragments", () => {
    const source = "API_KEY=abcdef sk-abcdef123456 user@example.com https://api.example/v1 /Volumes/PrivateDisk/project";
    const excerpt = redactNativeMemoryErrorExcerpt(source);
    expect(excerpt).toContain("API_KEY=<redacted>");
    expect(excerpt).toContain("<redacted-secret>");
    expect(excerpt).toContain("<redacted-email>");
    expect(excerpt).toContain("<redacted-url>");
    expect(excerpt).toContain("$VOLUME/project");
    expect(excerpt).not.toContain("abcdef123456");
    expect(excerpt).not.toContain("api.example");
  });

  it("fingerprints the raw error deterministically without embedding it", () => {
    expect(fingerprintNativeMemoryError("same error"))
      .toBe(fingerprintNativeMemoryError("same error"));
    expect(fingerprintNativeMemoryError("same error"))
      .not.toBe(fingerprintNativeMemoryError("different error"));
  });
});
