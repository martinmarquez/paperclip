import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectDatabaseBackupHealth, isDatabaseBackupDue } from "../services/database-backup-health.js";

const hour = 3_600_000;
const nowMs = Date.parse("2026-10-29T20:00:00Z");
const intervalMs = 8 * hour;

describe("database backup cadence across restarts", () => {
  it.each([
    { name: "missing backup", age: null, attempted: null, due: true },
    { name: "fresh persisted backup after restart", age: 2, attempted: null, due: false },
    { name: "overdue persisted backup after restart", age: 10, attempted: null, due: true },
    { name: "exact configured boundary", age: 8, attempted: null, due: true },
    { name: "failed attempt still backing off", age: 10, attempted: nowMs - hour, due: false },
    { name: "failed attempt due again", age: 20, attempted: nowMs - intervalMs, due: true },
    { name: "future backup timestamp", age: -4, attempted: null, due: true },
    { name: "clock moved back after attempt", age: 10, attempted: nowMs + hour, due: true },
    { name: "manual backup updates persisted cadence", age: 1, attempted: nowMs - 10 * hour, due: false },
  ])("$name", ({ age, attempted, due }) => {
    expect(isDatabaseBackupDue({ latestBackupMtime: age === null ? null : new Date(nowMs - age * hour).toISOString(),
      lastAttemptAtMs: attempted, intervalMs, nowMs })).toBe(due);
  });
  it("uses this instance's backup prefix and ignores future timestamps", () => {
    const dir = mkdtempSync(join(tmpdir(), "paperclip-backup-cadence-"));
    try {
      for (const [name, age] of [["paperclip-previous.sql.gz", 10], ["another-db.sql.gz", 1],
        ["paperclip-future.sql.gz", -4], ["paperclip-incomplete.sql.gz.partial", 0]] as const) {
        const file = join(dir, name); writeFileSync(file, "fixture");
        const at = new Date(nowMs - age * hour); utimesSync(file, at, at);
      }
      const health = inspectDatabaseBackupHealth({ enabled: true, backupDir: dir,
        filenamePrefix: "paperclip", maxAgeHours: 10, now: new Date(nowMs) });
      expect(health.latestBackup?.name).toBe("paperclip-previous.sql.gz");
      expect(isDatabaseBackupDue({ latestBackupMtime: health.latestBackup!.mtime,
        lastAttemptAtMs: null, intervalMs, nowMs })).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

});
