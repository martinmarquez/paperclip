// Prepared for isolated PostgreSQL CI. This is a test adapter, never a runtime registration.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDb } from "./client.ts";
import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createReviewPreflightSqlDatabase } from "./review-preflight-sql.ts";
import { ReviewPreflightSqlStore } from "../../../server/src/services/review-preflight-sql-store.ts";
import { hashEvidence } from "../../../server/src/services/review-preflight-bridge.ts";

const companyId = "00000000-0000-4000-8000-000000000010";
const otherCompanyId = "00000000-0000-4000-8000-000000000020";
const subject = { sha: "a".repeat(40), base: "b".repeat(40), tree: "c".repeat(40), bundleHash: "d".repeat(64) };
const testRoot = process.env.PAPERCLIP_PREFLIGHT_TEST_ROOT;
assert.ok(testRoot && basename(testRoot).startsWith("paperclip-preflight."), "requires the isolated harness root");
assert.equal(realpathSync(dirname(process.env.PGHOST)), realpathSync(testRoot));
assert.equal(process.env.PGHOST, join(testRoot, "socket"));
assert.equal(process.env.PGPORT, "55495");
assert.equal(process.env.PGUSER, "ren4950_test");
assert.ok(!process.env.PGUSERNAME || process.env.PGUSERNAME === "ren4950_test", "PGUSERNAME must not override the isolated role");
assert.equal(process.env.PGDATABASE, "postgres");
const nativeDb = createDb("", { maxConnections: 1, connectTimeoutSeconds: 3 });
const sql = nativeDb.$client;

const db = createReviewPreflightSqlDatabase(nativeDb);

const store = new ReviewPreflightSqlStore(db, async (tx, row, signal) => {
  const result = await tx.query("SELECT id FROM review_preflight_reservations WHERE company_id = $1 AND id = $2", [row.companyId, row.id], signal);
  return result.rows.length === 1;
});

function input(key, actorId = "board", targetCompanyId = companyId, selectedSubject = subject) {
  const now = new Date();
  return { id: randomUUID(), companyId: targetCompanyId, actorId, idempotencyKey: key,
    subject: selectedSubject, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 3_600_000).toISOString() };
}

function evidence(row) {
  const body = { schemaVersion: 1, requestId: row.id, prNumber: 971, subject: row.subject, principalId: row.actorId,
    reviewerIds: [], observations: { physical: { observedAt: new Date(Date.now() + 20_000).toISOString(),
      sourceRevision: "physical-clock-skew", sourceHash: "f".repeat(64), status: "UNKNOWN" } }, projections: {}, manifest: {},
    coverage: { auditPages: 0, auditPaginationComplete: false, auditCoverageVerified: false,
      sourcesComplete: false, manifestComplete: false, complete: false },
    attestation: { status: "UNKNOWN", reason: "production_attestation_unavailable" },
    decision: "HOLD", dispatchAllowed: false, diagnosticOnly: true };
  return { ...body, contentHash: hashEvidence(body) };
}

try {
  const mode = process.argv[2];
  const key = "physical_key_123456789";
  if (mode === "race") {
    const result = await store.reserve(input(process.argv[3]));
    process.stdout.write(JSON.stringify({ workerPid: process.pid, kind: result.kind, id: "reservation" in result ? result.reservation.id : null }) + "\n");
  } else if (mode === "verify") {
    const row = await sql`SELECT id FROM review_preflight_reservations WHERE company_id = ${companyId} LIMIT 1`;
    assert.equal(row.length, 1, "one reservation survives both processes and restart");
    const id = row[0].id;
    assert.equal((await store.get(companyId, id))?.status, "pending");
    assert.equal(await store.get(otherCompanyId, id), null, "cross-company read denied");
    assert.equal((await store.reserve(input(process.argv[3]))).kind, "existing", "idempotency survives restart");
    assert.equal((await store.reserve(input(process.argv[3], "board", companyId, { ...subject, sha: "e".repeat(40) }))).kind, "conflict");
    assert.equal((await store.reserve(input(key))).kind, "pending_unresolved", "pending excludes another key without a retry hint");
    const pending = await store.get(companyId, id);
    assert.equal(await store.publishHold({ requestId: id, companyId, actorId: "intruder", evidence: evidence(pending) }, async () => true), false);
    assert.equal(await store.publishHold({ requestId: id, companyId, actorId: "board", evidence: evidence(pending) }, async () => false), false,
      "revoked guard prevents publication");
    assert.equal((await store.get(companyId, id))?.status, "pending");
    const hungAuthority = new ReviewPreflightSqlStore(db, async (tx) => {
      await tx.query("SELECT pg_sleep(30)");
      return true;
    });
    await assert.rejects(hungAuthority.publishHold({ requestId: id, companyId, actorId: "board", evidence: evidence(pending) }, async () => true));
    assert.equal((await store.get(companyId, id))?.status, "pending", "timed-out publication rolls back");
    const runningSleeps = await sql`SELECT count(*)::integer AS count FROM pg_stat_activity
      WHERE pid <> pg_backend_pid() AND state = 'active' AND query LIKE '%pg_sleep(30)%'`;
    assert.equal(runningSleeps[0].count, 0, "cancelled operation leaves no live privileged query");
    assert.equal(await store.publishHold({ requestId: id, companyId, actorId: "board", evidence: evidence(pending) }, async () => true), true);
    const storedEvidence = (await store.get(companyId, id))?.evidence;
    assert.ok(storedEvidence, "published evidence is readable after jsonb storage");
    const { contentHash, ...storedBody } = storedEvidence;
    assert.equal(hashEvidence(storedBody), contentHash, "digest survives the actual PostgreSQL jsonb roundtrip");
    assert.equal(await store.publishHold({ requestId: id, companyId, actorId: "board", evidence: evidence(pending) }, async () => true), false,
      "single publication");
    assert.equal((await store.reserve(input(key))).kind, "rate_limited", "rolling hour survives publication");
    const oldId = randomUUID();
    await sql`INSERT INTO review_preflight_reservations
      (id, company_id, actor_id, idempotency_key, sha, base_sha, tree_sha, bundle_hash, created_at, expires_at)
      VALUES (${oldId},${companyId},'board','old_pending_key_123456',${subject.sha},${subject.base},${subject.tree},${subject.bundleHash},
        now() - interval '2 hours', now() - interval '1 hour')`;
    assert.equal((await store.reserve(input("after_expiry_123456"))).kind, "pending_unresolved", "uncertain work remains fenced after an hour");
    process.stdout.write("store API: restart, idempotency, quota, company, actor, revocation, publication passed\n");
  } else throw new Error("invalid physical harness mode");
} finally { await sql.end({ timeout: 1 }); }
