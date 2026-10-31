import { boundedOperation, evidenceFresh, hashEvidence, type Evidence, type Reservation, type ReservationStore, type ReserveResult, type Subject } from "./review-preflight-bridge.js";
import type { PreflightSqlDatabase, PreflightSqlExecutor } from "@paperclipai/db";

// Native adapter. Schema changes use the registered migration path, never a query-side bootstrap.
export type SqlExecutor = PreflightSqlExecutor;
export type SqlDatabase = PreflightSqlDatabase;

type Row = Record<string, unknown> & {
  id: string; company_id: string; actor_id: string; idempotency_key: string;
  sha: string; base_sha: string; tree_sha: string; bundle_hash: string;
  created_at: Date | string; expires_at: Date | string; status: "pending" | "hold";
  evidence: Evidence | null;
};
const rowFields = "id, company_id, actor_id, idempotency_key, sha, base_sha, tree_sha, bundle_hash, created_at, expires_at, status, evidence";
const iso = (value: Date | string) => new Date(value).toISOString();
const toReservation = (row: Row): Reservation => ({
  id: row.id, companyId: row.company_id, actorId: row.actor_id, idempotencyKey: row.idempotency_key,
  subject: { sha: row.sha, base: row.base_sha, tree: row.tree_sha, bundleHash: row.bundle_hash },
  createdAt: iso(row.created_at), expiresAt: iso(row.expires_at), status: row.status, evidence: row.evidence,
});
const sameSubject = (a: Subject, b: Subject) => a.sha === b.sha && a.base === b.base
  && a.tree === b.tree && a.bundleHash === b.bundleHash;
const validEvidence = (evidence: Evidence) => {
  const { contentHash, ...body } = evidence;
  return contentHash === hashEvidence(body)
    && evidence.decision === "HOLD" && evidence.dispatchAllowed === false
    && evidence.diagnosticOnly === true && evidence.coverage.complete === false;
};

export type PublicationAuthority = (tx: SqlExecutor, row: Reservation, signal: AbortSignal) => Promise<boolean>;

export class ReviewPreflightSqlStore implements ReservationStore {
  constructor(private readonly db: SqlDatabase, private readonly publicationAuthority?: PublicationAuthority) {}

  private async boundedTransaction<T>(signal: AbortSignal | undefined, work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    if (signal?.aborted) throw new Error("preflight_sql_cancelled");
    const active = signal ?? new AbortController().signal;
    return this.db.transaction(async (raw) => {
      await raw.query("SET LOCAL statement_timeout = '3000ms'", [], active);
      await raw.query("SET LOCAL lock_timeout = '1000ms'", [], active);
      const tx: SqlExecutor = { query: <T extends Record<string, unknown>>(sql: string, params?: readonly unknown[], operationSignal?: AbortSignal) =>
        raw.query<T>(sql, params, operationSignal ?? active) };
      return work(tx);
    }, { signal: active, timeoutMs: 3_000 });
  }

  async reserve(input: Omit<Reservation, "status" | "evidence">, signal?: AbortSignal): Promise<ReserveResult> {
    return this.boundedTransaction<ReserveResult>(signal, async (tx) => {
      // A durable per-company row serializes all actors and processes before either quota check.
      await tx.query("INSERT INTO review_preflight_company_locks (company_id) VALUES ($1) ON CONFLICT DO NOTHING", [input.companyId]);
      await tx.query("SELECT company_id FROM review_preflight_company_locks WHERE company_id = $1 FOR UPDATE", [input.companyId]);
      const prior = await tx.query<Row>(`SELECT ${rowFields} FROM review_preflight_reservations WHERE company_id = $1 AND actor_id = $2 AND idempotency_key = $3`,
        [input.companyId, input.actorId, input.idempotencyKey]);
      if (prior.rows[0]) {
        const reservation = toReservation(prior.rows[0]);
        return sameSubject(reservation.subject, input.subject)
          ? { kind: "existing", reservation } : { kind: "conflict" };
      }
      const clock = await tx.query<{ now_at: Date | string }>("SELECT clock_timestamp() AS now_at");
      const now = new Date(clock.rows[0].now_at);
      const pending = await tx.query<{ id: string }>("SELECT id FROM review_preflight_reservations WHERE company_id = $1 AND status = 'pending' LIMIT 1",
        [input.companyId]);
      if (pending.rows.length) return { kind: "pending_unresolved" };
      const recent = await tx.query<{ created_at: Date | string }>("SELECT created_at FROM review_preflight_reservations WHERE company_id = $1 AND created_at > $2 ORDER BY created_at DESC LIMIT 1",
        [input.companyId, new Date(now.getTime() - 60 * 60_000)]);
      if (recent.rows[0]) {
        const retryAfterSeconds = Math.max(1, Math.ceil((new Date(recent.rows[0].created_at).getTime() + 60 * 60_000 - now.getTime()) / 1000));
        return { kind: "rate_limited", retryAfterSeconds };
      }
      const inserted = await tx.query<Row>(`INSERT INTO review_preflight_reservations
        (id, company_id, actor_id, idempotency_key, sha, base_sha, tree_sha, bundle_hash, created_at, expires_at, status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending') RETURNING ${rowFields}`,
        [input.id, input.companyId, input.actorId, input.idempotencyKey, input.subject.sha, input.subject.base,
          input.subject.tree, input.subject.bundleHash, now, new Date(now.getTime() + 60 * 60_000)]);
      return { kind: "created", reservation: toReservation(inserted.rows[0]) };
    });
  }

  async get(companyId: string, requestId: string, signal?: AbortSignal): Promise<Reservation | null> {
    return this.boundedTransaction(signal, async (tx) => {
      const result = await tx.query<Row>(`SELECT ${rowFields} FROM review_preflight_reservations WHERE company_id = $1 AND id = $2`,
        [companyId, requestId]);
      return result.rows[0] ? toReservation(result.rows[0]) : null;
    });
  }

  async publishHold(input: { requestId: string; companyId: string; actorId: string; evidence: Evidence },
    guard: (signal: AbortSignal) => Promise<boolean>, signal?: AbortSignal): Promise<boolean> {
    // Without a real authority adapter using this same transaction, publication stays disabled.
    if (!this.publicationAuthority) return false;
    return this.boundedTransaction(signal, async (tx) => {
      const locked = await tx.query<Row>(`SELECT ${rowFields} FROM review_preflight_reservations
        WHERE company_id = $1 AND id = $2 FOR UPDATE`, [input.companyId, input.requestId]);
      const row = locked.rows[0];
      if (!row || row.actor_id !== input.actorId || row.status !== "pending") return false;
      const reservation = toReservation(row);
      const clock = await tx.query<{ now_at: Date | string }>("SELECT clock_timestamp() AS now_at");
      const now = new Date(clock.rows[0].now_at);
      if (now >= new Date(reservation.expiresAt) || input.evidence.requestId !== row.id
        || input.evidence.principalId !== row.actor_id || !validEvidence(input.evidence)
        || !sameSubject(input.evidence.subject, reservation.subject) || !evidenceFresh(input.evidence, now)) return false;
      const active = signal ?? new AbortController().signal;
      if (!await boundedOperation(active, 3_000, (signal) => this.publicationAuthority!(tx, reservation, signal))
        || !await boundedOperation(active, 3_000, guard)) return false;
      if (signal?.aborted) throw new Error("preflight_sql_cancelled");
      const updated = await tx.query<{ id: string }>(`UPDATE review_preflight_reservations SET status = 'hold', evidence = $1
        WHERE company_id = $2 AND id = $3 AND actor_id = $4 AND status = 'pending'
          AND expires_at > clock_timestamp() RETURNING id`,
        [input.evidence, input.companyId, input.requestId, input.actorId]);
      return updated.rows.length === 1;
    });
  }
}
