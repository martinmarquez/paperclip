// Prepared for isolated PostgreSQL CI. This is a test adapter, never a runtime registration.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDb } from "./client.ts";
import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createReviewPreflightSqlDatabase } from "./review-preflight-sql.ts";
import { ReviewPreflightSqlStore } from "../../../server/src/services/review-preflight-sql-store.ts";
import { createNativePreflightAuthority } from "../../../server/src/services/review-preflight-authority.ts";
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
    // Native ACL rows are isolated fixtures, with the same columns and lock targets as the instance.
    await sql`CREATE TABLE company_memberships (company_id uuid, principal_type text, principal_id text, status text, membership_role text)`;
    await sql`CREATE TABLE principal_permission_grants (company_id uuid, principal_type text, principal_id text, permission_key text, scope jsonb)`;
    await sql`INSERT INTO company_memberships VALUES (${companyId}, 'user', 'board', 'active', 'owner')`;
    const grant = { companyId, subjectSha: subject.sha, expiresAt: new Date(Date.now() + 600_000).toISOString() };
    await db.query("INSERT INTO principal_permission_grants VALUES ($1,'user','board','review-preflight:run',$2)", [companyId, grant]);
    const nativeAuthority = createNativePreflightAuthority(db, subject);
    const board = { type: "board", id: "board", source: "session" };
    assert.equal(await nativeAuthority.can(board, "review-preflight:run", companyId), true);
    assert.equal(await nativeAuthority.can(board, "review-preflight:run", otherCompanyId), false);
    await sql`UPDATE company_memberships SET membership_role = 'operator' WHERE principal_id = 'board'`;
    assert.equal(await nativeAuthority.can(board, "review-preflight:run", companyId), true, "native operator role supports an explicit run grant");
    await sql`UPDATE company_memberships SET membership_role = 'viewer' WHERE principal_id = 'board'`;
    assert.equal(await nativeAuthority.can(board, "review-preflight:run", companyId), false, "viewer membership cannot publish even with a grant");
    await sql`UPDATE company_memberships SET membership_role = 'owner' WHERE principal_id = 'board'`;

    let acquired, release;
    const ready = new Promise(resolve => { acquired = resolve; });
    const hold = new Promise(resolve => { release = resolve; });
    const publication = db.transaction(async tx => {
      assert.equal(await nativeAuthority.publicationAuthority(tx, { actorId: "board", companyId }, new AbortController().signal), true);
      acquired();
      await hold;
    }, { signal: new AbortController().signal, timeoutMs: 3_000 }).then(() => null, error => error);
    const earlyFailure = await Promise.race([ready.then(() => null), publication]);
    if (earlyFailure) throw earlyFailure;
    const revocation = Promise.resolve(sql`DELETE FROM principal_permission_grants WHERE principal_id = 'board'`);
    try {
      let blocked = false;
      for (let attempt = 0; attempt < 60; attempt++) {
        // The main connection is executing the blocked DELETE; observe on a separate native connection.
        const probe = await db.transaction(tx => tx.query("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE 'DELETE FROM principal_permission_grants%') AS blocked"),
          { signal: new AbortController().signal, timeoutMs: 1_000 });
        if (probe.rows[0].blocked) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(blocked, true, "native revocation waits for the publication's native ACL lock");
    } finally {
      release();
      const publicationFailure = await publication;
      await revocation;
      if (publicationFailure) throw publicationFailure;
    }
    assert.equal(await nativeAuthority.can(board, "review-preflight:run", companyId), false, "revocation applies before the next publication");
    process.stdout.write("native authority: exact subject, company and transactional revocation passed\n");
    const sampleAt = new Date("2026-10-30T12:00:00.000Z");
    const bound = await db.query("SELECT $1::timestamptz AS at, $2::jsonb AS payload, $3::integer AS n, $4::boolean AS ok",
      [sampleAt, { sample: "json" }, 3, true]);
    assert.equal(new Date(bound.rows[0].at).toISOString(), sampleAt.toISOString());
    assert.deepEqual(bound.rows[0].payload, { sample: "json" });
    assert.equal(bound.rows[0].n, 3);
    assert.equal(bound.rows[0].ok, true);
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
    const externalStop = new AbortController();
    let externalStartedAt;
    await assert.rejects(db.transaction(async tx => {
      externalStartedAt = performance.now();
      const stopTimer = setTimeout(() => externalStop.abort(), 200);
      try { await tx.query("SELECT pg_sleep(30)"); }
      finally { clearTimeout(stopTimer); }
    }, { signal: externalStop.signal, timeoutMs: 3_000 }));
    assert.ok(performance.now() - externalStartedAt < 1_500, "external cancellation settles before the server statement deadline");
    const afterStop = await sql`SELECT count(*)::integer AS count FROM pg_stat_activity
      WHERE pid <> pg_backend_pid() AND state = 'active' AND query LIKE '%pg_sleep(30)%'`;
    assert.equal(afterStop[0].count, 0, "external cancellation is acknowledged without leaving a running query");
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
