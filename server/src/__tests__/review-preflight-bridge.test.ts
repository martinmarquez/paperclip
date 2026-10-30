import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { reviewPreflightBridgeRoutes } from "../routes/review-preflight-bridge.js";
import {
  collectDiagnostic, fixedResourcePaths, hashEvidence, type BridgeScope,
  type BoardHostReader, type BridgeDependencies, type Evidence, type Principal,
  type Reservation, type ReservationStore, type ReserveResult, type SourceKind,
} from "../services/review-preflight-bridge.js";

const scope: BridgeScope = {
  companyId: "00000000-0000-4000-8000-000000000010", prNumber: 100,
  reviewerIds: ["00000000-0000-4000-8000-000000000011", "00000000-0000-4000-8000-000000000012"],
  readerAgentIds: ["00000000-0000-4000-8000-000000000013", "00000000-0000-4000-8000-000000000014"],
  operatorUserIds: ["board-test"],
};
const board: Principal = { type: "board", id: "board-test", source: "session" };
const boardKey: Principal = { type: "board", id: "board-test", source: "board_key" };
const otherBoard: Principal = { type: "board", id: "other-board", source: "session" };
const devops: Principal = { type: "agent", id: scope.readerAgentIds[0], source: "agent_jwt" };
const sre: Principal = { type: "agent", id: scope.readerAgentIds[1], source: "agent_jwt" };
const devopsKey: Principal = { type: "agent", id: scope.readerAgentIds[0], source: "agent_key", keyId: "historical-key" };
const reviewer: Principal = { type: "agent", id: scope.reviewerIds[0], source: "agent_key", keyId: "historical-key" };
const other: Principal = { type: "agent", id: "00000000-0000-4000-8000-000000000001", source: "agent_key" };
const subject = { sha: "a".repeat(40), base: "b".repeat(40), tree: "c".repeat(40), bundleHash: "d".repeat(64) };
const path = `/api/companies/${scope.companyId}/review-preflight-extractions`;
const hash = "f".repeat(64);

class SyntheticStore implements ReservationStore {
  rows = new Map<string, Reservation>();
  beforeReserve?: () => Promise<void>;
  beforePublish?: () => Promise<void>;
  beforeGet?: () => Promise<void>;
  async reserve(input: Omit<Reservation, "status" | "evidence">): Promise<ReserveResult> {
    await this.beforeReserve?.();
    const rows = [...this.rows.values()];
    const existing = rows.find((row) => row.companyId === input.companyId && row.actorId === input.actorId
      && row.idempotencyKey === input.idempotencyKey);
    if (existing) {
      return JSON.stringify(existing.subject) === JSON.stringify(input.subject)
        ? { kind: "existing", reservation: existing } : { kind: "conflict" };
    }
    for (const row of rows) {
      const age = Date.parse(input.createdAt) - Date.parse(row.createdAt);
      if (row.companyId === input.companyId && row.status === "pending") return { kind: "pending_unresolved" };
      if (row.companyId === input.companyId && age >= 0 && age < 60 * 60_000) {
        return { kind: "rate_limited", retryAfterSeconds: Math.max(1,
          Math.ceil((Date.parse(row.createdAt) + 60 * 60_000 - Date.parse(input.createdAt)) / 1000)) };
      }
    }
    const row: Reservation = { ...input, status: "pending", evidence: null };
    this.rows.set(row.id, row);
    return { kind: "created", reservation: row };
  }
  async get(companyId: string, requestId: string): Promise<Reservation | null> {
    await this.beforeGet?.();
    const row = this.rows.get(requestId);
    return row?.companyId === companyId ? row : null;
  }
  async publishHold(input: { requestId: string; companyId: string; actorId: string; evidence: Evidence },
    guard: (signal: AbortSignal) => Promise<boolean>, signal?: AbortSignal): Promise<boolean> {
    await this.beforePublish?.();
    if (!await guard(signal ?? new AbortController().signal)) return false;
    const row = this.rows.get(input.requestId);
    if (!row || row.companyId !== input.companyId || row.actorId !== input.actorId || row.status !== "pending") return false;
    row.status = "hold";
    row.evidence = input.evidence;
    return true;
  }
}

function setup(options: { enabled?: boolean; noReader?: boolean; partialAudit?: boolean; stale?: boolean; revokeAfterFirstRead?: boolean; expireAfterFirstRead?: boolean; missingManifest?: boolean; permittedSecret?: boolean; boardViewer?: boolean; missingBoardMembership?: boolean; auditFailure?: boolean } = {}) {
  const store = new SyntheticStore();
  const permissions = new Set(["board-test:review-preflight:run", ...scope.readerAgentIds.map((id) => `${id}:review-preflight:evidence-read`)]);
  const deniedRequestIds = new Set<string>();
  let clock = new Date("2026-10-28T18:00:00.000Z");
  let reads = 0;
  const audit: Array<{ action: string; requestId: string }> = [];
  const reader: BoardHostReader = {
    async read(kind: SourceKind, _id, cursor) {
      reads++;
      if (options.revokeAfterFirstRead && reads === 1) permissions.delete("board-test:review-preflight:run");
      if (options.expireAfterFirstRead && reads === 1) clock = new Date(clock.getTime() + 61 * 60_000);
      const data = {
        configuration: { adapterType: "codex_local", cwd: options.permittedSecret ? "/synthetic/SECRET_SENTINEL" : "/synthetic", sandbox: "workspace-write", secret: "SECRET_SENTINEL" },
        keys: [{ id: "synthetic-key", scope: "standard", createdAt: clock.toISOString(), revokedAt: null, value: "SECRET_SENTINEL" }],
        profile: { profileNames: [], bindingNames: [], token: "SECRET_SENTINEL" },
        environment: { names: ["Synthetic"], drivers: ["local"], password: "SECRET_SENTINEL" },
        audit: { events: [{ id: "event-1", actorId: "test", action: options.permittedSecret ? "SECRET_SENTINEL" : "read", secret: "SECRET_SENTINEL" }], nextCursor: options.permittedSecret ? "SECRET_SENTINEL" : options.partialAudit && !cursor ? "next" : null },
      }[kind];
      return {
        data: options.partialAudit && kind === "audit" && cursor ? {} : data,
        observation: { observedAt: new Date(clock.getTime() - (options.stale ? 16 : 0) * 60_000).toISOString(), sourceRevision: options.permittedSecret ? "SECRET_SENTINEL" : "synthetic", sourceHash: hash, status: "PASS" },
        rawSecret: "SECRET_SENTINEL",
      };
    },
    async readManifest() {
      return options.missingManifest ? null : {
        data: { engine: "synthetic", policyId: "test", policyVersion: "1", uid: 1000, gid: 1000, cwd: "/synthetic", mounts: options.permittedSecret ? [{ path: "/SECRET_SENTINEL", access: "ro" }] : [], scratch: "/scratch", egress: "denied", secret: "SECRET_SENTINEL" },
        observation: { observedAt: clock.toISOString(), sourceRevision: "synthetic", sourceHash: hash, status: "PASS" },
      };
    },
  };
  const deps: BridgeDependencies = {
    enabled: options.enabled ?? true, scope, subject, store, reader: options.noReader ? undefined : reader,
    can: async (principal, permission, _companyId, requestId) => permissions.has(`${principal.id}:${permission}`)
      && (!requestId || !deniedRequestIds.has(requestId)),
    verifyOrigin: (origin) => origin === "https://board.test",
    now: () => clock,
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const actor = { board, boardKey, otherBoard, devops, devopsKey, sre, reviewer, other }[req.get("x-test-actor") as "board" | "boardKey" | "otherBoard" | "devops" | "devopsKey" | "sre" | "reviewer" | "other"] ?? other;
    Object.defineProperty(req, "actor", { value: actor.type === "board"
      ? { type: "board", userId: actor.id, source: actor.source, keyId: actor.keyId, companyIds: options.missingBoardMembership ? [] : [scope.companyId],
        memberships: [{ companyId: scope.companyId, membershipRole: options.boardViewer ? "viewer" : "admin", status: "active" }] }
      : { type: "agent", agentId: actor.id, source: actor.source, keyId: actor.keyId, companyId: scope.companyId } });
    next();
  });
  app.use("/api", reviewPreflightBridgeRoutes(deps, async (_req, entry) => {
    if (options.auditFailure) throw new Error("synthetic_audit_unavailable");
    audit.push(entry);
  }));
  return { app, deps, store, permissions, deniedRequestIds, audit, get reads() { return reads; }, advance(minutes: number) { clock = new Date(clock.getTime() + minutes * 60_000); } };
}

function post(app: ReturnType<typeof setup>["app"], actor = "board", key = "one_unique_request_key", body: Record<string, unknown> = {}) {
  return request(app).post(path).set("x-test-actor", actor).set("origin", "https://board.test").set("idempotency-key", key).send(body);
}

describe("disabled REN-4950 Board bridge contract", () => {
  it("requires current company membership and a writable Board role", async () => {
    expect((await post(setup({ missingBoardMembership: true }).app)).status).toBe(403);
    expect((await post(setup({ boardViewer: true }).app)).status).toBe(403);
  });

  it("retains uncertainty and never starts extraction when reservation auditing fails", async () => {
    const fixture = setup({ auditFailure: true });
    const accepted = await post(fixture.app);
    expect(accepted.status).toBe(202);
    expect(accepted.body.status).toBe("uncertain");
    expect(fixture.reads).toBe(0);
    expect(fixture.store.rows.get(accepted.body.requestId)?.status).toBe("pending");
    const replay = await post(fixture.app);
    expect(replay.body.requestId).toBe(accepted.body.requestId);
    expect(fixture.reads).toBe(0);
  });

  it("hashes evidence independently of nested JSON object key order", async () => {
    const fixture = setup();
    const accepted = await post(fixture.app);
    const evidence = fixture.store.rows.get(accepted.body.requestId)?.evidence;
    expect(evidence).not.toBeNull();
    if (!evidence) throw new Error("fixture evidence missing");
    const { contentHash, ...body } = evidence;
    const reordered = {
      ...body,
      subject: { tree: body.subject.tree, bundleHash: body.subject.bundleHash, base: body.subject.base, sha: body.subject.sha },
    };
    expect(hashEvidence(reordered)).toBe(contentHash);
    expect(hashEvidence({ ...reordered, subject: { ...reordered.subject, sha: "e".repeat(40) } })).not.toBe(contentHash);
  });

  it("does not begin collection when the parent request is already cancelled", async () => {
    const fixture = setup();
    const accepted = await post(fixture.app);
    const reservation = fixture.store.rows.get(accepted.body.requestId);
    if (!reservation) throw new Error("fixture reservation missing");
    const reads = fixture.reads;
    const parent = new AbortController();
    parent.abort();
    expect(await collectDiagnostic(fixture.deps, board, reservation, parent.signal)).toBeNull();
    expect(fixture.reads).toBe(reads);
  });

  it("bounds a hung admission check before any reservation or privileged read", async () => {
    const fixture = setup();
    fixture.deps.ioLimits = { totalMs: 30, callMs: 10 };
    fixture.deps.can = async () => new Promise<boolean>(() => {});
    const result = await post(fixture.app);
    expect(result.status).toBe(503);
    expect(result.body.status).toBe("uncertain");
    expect(fixture.store.rows.size).toBe(0);
    expect(fixture.reads).toBe(0);
  });

  it("bounds an uncertain reserve without starting extraction or a second store call", async () => {
    const fixture = setup();
    fixture.deps.ioLimits = { totalMs: 30, callMs: 10 };
    fixture.store.beforeReserve = async () => new Promise<void>(() => {});
    const result = await post(fixture.app);
    expect(result.status).toBe(503);
    expect(result.body.status).toBe("uncertain");
    expect(fixture.reads).toBe(0);
  });

  it("bounds a hung publication and GET, leaving the reservation uncertain", async () => {
    const postFixture = setup();
    postFixture.deps.ioLimits = { totalMs: 30, callMs: 10 };
    postFixture.store.beforePublish = async () => new Promise<void>(() => {});
    const postResult = await post(postFixture.app);
    expect(postResult.status).toBe(202);
    expect(postResult.body.status).toBe("uncertain");
    expect(postFixture.store.rows.get(postResult.body.requestId)?.status).toBe("pending");
    const getFixture = setup();
    getFixture.deps.ioLimits = { totalMs: 30, callMs: 10 };
    const accepted = await post(getFixture.app);
    getFixture.store.beforeGet = async () => new Promise<void>(() => {});
    const read = await request(getFixture.app).get(`${path}/${accepted.body.requestId}`).set("x-test-actor", "devops");
    expect(read.status).toBe(503);
    expect(read.body.dispatchAllowed).toBe(false);
  });

  it("aborts a hung source call, retains uncertainty, and never replays it", async () => {
    const fixture = setup();
    let calls = 0;
    let aborted = false;
    fixture.deps.ioLimits = { totalMs: 40, callMs: 10 };
    fixture.deps.reader!.read = async (_kind, _id, _cursor, signal) => {
      calls++;
      signal.addEventListener("abort", () => { aborted = true; });
      return new Promise<unknown>(() => {});
    };
    const first = await post(fixture.app);
    expect(first.status).toBe(202);
    expect(fixture.store.rows.get(first.body.requestId)?.status).toBe("pending");
    expect(aborted).toBe(true);
    expect(calls).toBe(1);
    const again = await post(fixture.app);
    expect(again.body.requestId).toBe(first.body.requestId);
    expect(calls).toBe(1);
  });

  it("stops when the global deadline expires during a call", async () => {
    const fixture = setup();
    let calls = 0;
    fixture.deps.ioLimits = { totalMs: 10, callMs: 40 };
    fixture.deps.reader!.read = async () => { calls++; return new Promise<unknown>(() => {}); };
    const result = await post(fixture.app);
    expect(result.status).toBe(202);
    expect(calls).toBe(1);
    expect(fixture.store.rows.get(result.body.requestId)?.evidence).toBeNull();
  });

  it("does not start a second read after expiry during the first call", async () => {
    const fixture = setup();
    let calls = 0;
    fixture.deps.reader!.read = async () => {
      calls++;
      fixture.advance(61);
      return { data: {}, observation: {} };
    };
    const result = await post(fixture.app);
    expect(result.status).toBe(202);
    expect(calls).toBe(1);
    expect(fixture.store.rows.get(result.body.requestId)?.status).toBe("pending");
  });

  it("uses eight fixed resource paths from server scope", () => {
    const paths = fixedResourcePaths(scope);
    expect(paths).toHaveLength(8);
    expect(new Set(paths).size).toBe(8);
    expect(paths.filter((item) => item.includes("/audit/"))).toHaveLength(1);
    for (const id of scope.reviewerIds) expect(paths.filter((item) => item.includes(id))).toHaveLength(3);
  });

  it("fails closed with an invalid scope or unresolved server subject", async () => {
    const invalid = setup();
    invalid.deps.scope = { ...scope, readerAgentIds: [scope.reviewerIds[0], scope.readerAgentIds[1]] };
    expect((await post(invalid.app)).status).toBe(403);
    const unknown = setup();
    unknown.deps.subject = null;
    expect((await post(unknown.app)).status).toBe(503);
    expect(unknown.store.rows.size).toBe(0);
  });

  it("returns UNKNOWN/HOLD when no source adapter is installed", async () => {
    const fixture = setup({ noReader: true });
    const accepted = await post(fixture.app);
    const read = await request(fixture.app).get(`${path}/${accepted.body.requestId}`).set("x-test-actor", "devops");
    expect(accepted.status).toBe(202);
    expect(fixture.reads).toBe(0);
    expect(read.body.evidence.coverage.complete).toBe(false);
    expect(read.body.evidence.coverage.sourcesComplete).toBe(false);
    expect(read.body.evidence.attestation.status).toBe("UNKNOWN");
    expect(read.body.dispatchAllowed).toBe(false);
  });

  it("denies legacy keys even with an allowlisted reader agent ID", async () => {
    const fixture = setup();
    const accepted = await post(fixture.app);
    const read = await request(fixture.app).get(`${path}/${accepted.body.requestId}`)
      .set("x-test-actor", "devopsKey");
    expect(read.status).toBe(403);
  });

  it("has no registered endpoint by default", async () => {
    const { app } = setup({ enabled: false });
    expect((await post(app)).status).toBe(404);
    expect((await request(app).get(`${path}/00000000-0000-4000-8000-000000000001`)).status).toBe(404);
  });

  it("denies both endpoints to reviewers, old keys, other agents, and cross-company callers", async () => {
    const { app, deniedRequestIds } = setup();
    expect((await post(app, "reviewer")).status).toBe(403);
    expect((await post(app, "other")).status).toBe(403);
    expect((await request(app).post(path.replace(scope.companyId, "00000000-0000-4000-8000-000000000002")).set("x-test-actor", "board").send({})).status).toBe(403);
    const accepted = await post(app);
    expect(accepted.status).toBe(202);
    for (const actor of ["board", "reviewer", "other"]) {
      expect((await request(app).get(`${path}/${accepted.body.requestId}`).set("x-test-actor", actor)).status).toBe(403);
    }
    expect((await request(app).get(`${path}/${accepted.body.requestId}`).set("x-test-actor", "devops")).status).toBe(200);
    expect((await request(app).get(`${path}/${accepted.body.requestId}`).set("x-test-actor", "sre")).status).toBe(200);
    deniedRequestIds.add(accepted.body.requestId);
    expect((await request(app).get(`${path}/${accepted.body.requestId}`).set("x-test-actor", "devops")).status).toBe(403);
    expect((await request(app).get(`${path.replace(scope.companyId, "00000000-0000-4000-8000-000000000002")}/${accepted.body.requestId}`).set("x-test-actor", "devops")).status).toBe(403);
    expect((await request(app).get(`${path}/00000000-0000-4000-8000-000000000001`).set("x-test-actor", "devops")).status).toBe(404);
    expect((await request(app).put(`${path}/${accepted.body.requestId}`).set("x-test-actor", "devops").send({ decision: "PASS" })).status).toBe(404);
    expect((await request(app).delete(`${path}/${accepted.body.requestId}`).set("x-test-actor", "reviewer")).status).toBe(404);
  });

  it("requires Board session, origin, explicit permission, and no client subject", async () => {
    const { app, permissions } = setup();
    expect((await request(app).post(path).set("x-test-actor", "board").set("idempotency-key", "one_unique_request_key").send({})).status).toBe(403);
    expect((await post(app, "boardKey")).status).toBe(403);
    expect((await post(app, "otherBoard")).status).toBe(403);
    expect((await post(app, "board", "one_unique_request_key", { path: "/arbitrary" })).status).toBe(400);
    permissions.delete("board-test:review-preflight:run");
    expect((await post(app)).status).toBe(403);
  });

  it("reserves once across concurrent calls; same key is idempotent and altered payload conflicts", async () => {
    const fixture = setup();
    const { app } = fixture;
    const [first, second] = await Promise.all([post(app, "board", "key_one_123456789"), post(app, "board", "key_two_123456789")]);
    expect([first.status, second.status]).toContain(202);
    expect([409, 429]).toContain(first.status === 202 ? second.status : first.status);
    expect(fixture.store.rows.size).toBe(1);
    const accepted = first.status === 202 ? first : second;
    const key = first.status === 202 ? "key_one_123456789" : "key_two_123456789";
    const replay = await post(app, "board", key);
    expect(replay.body.requestId).toBe(accepted.body.requestId);
    expect(fixture.audit).toEqual([
      { action: "review_preflight.reserved", requestId: accepted.body.requestId },
      { action: "review_preflight.evidence_stored", requestId: accepted.body.requestId },
    ]);
    expect((await post(app, "board", key, { sha: "e".repeat(40) })).status).toBe(400);
    expect(fixture.reads).toBe(8);
    fixture.deps.subject = { ...subject, sha: "e".repeat(40) };
    expect((await post(app, "board", key)).status).toBe(409);
    expect(fixture.reads).toBe(8);
  });

  it("holds incomplete audit and missing manifest without leaking sentinel secrets", async () => {
    const { app } = setup({ partialAudit: true, missingManifest: true });
    const accepted = await post(app);
    const read = await request(app).get(`${path}/${accepted.body.requestId}`).set("x-test-actor", "devops");
    expect(read.body.dispatchAllowed).toBe(false);
    expect(read.body.evidence.coverage.complete).toBe(false);
    expect(read.body.evidence.coverage.auditPaginationComplete).toBe(false);
    expect(read.body.evidence.coverage.sourcesComplete).toBe(false);
    expect(read.body.evidence.coverage.manifestComplete).toBe(false);
    expect(read.body.evidence.coverage.auditCoverageVerified).toBe(false);
    expect(Object.values(read.body.evidence.manifest).every((value) => (value as { observation: { status: string } }).observation.status === "UNKNOWN")).toBe(true);
    expect(JSON.stringify(read.body)).not.toContain("SECRET_SENTINEL");
  });

  it("withholds stale evidence during collection and after retrieval delay", async () => {
    const stale = setup({ stale: true });
    const pending = await post(stale.app);
    expect(stale.store.rows.get(pending.body.requestId)?.evidence).toBeNull();

    const later = setup();
    const accepted = await post(later.app);
    later.advance(16);
    const read = await request(later.app).get(`${path}/${accepted.body.requestId}`).set("x-test-actor", "devops");
    expect(read.status).toBe(200);
    expect(read.body.evidence).toBeNull();
  });

  it("keeps audit cursors internal and redacts secret text in permitted fields", async () => {
    const { app } = setup({ permittedSecret: true });
    const accepted = await post(app);
    const read = await request(app).get(`${path}/${accepted.body.requestId}`).set("x-test-actor", "devops");
    expect(read.status).toBe(200);
    expect(read.body.evidence.coverage.auditPaginationComplete).toBe(false);
    expect(JSON.stringify(read.body)).not.toContain("SECRET_SENTINEL");
    expect(JSON.stringify(read.body)).not.toContain("nextCursor");
  });

  it("does not mark missing manifest alone as complete", async () => {
    const { app } = setup({ missingManifest: true });
    const accepted = await post(app);
    const read = await request(app).get(`${path}/${accepted.body.requestId}`).set("x-test-actor", "devops");
    expect(read.body.evidence.coverage.auditPaginationComplete).toBe(true);
    expect(read.body.evidence.coverage.manifestComplete).toBe(false);
    expect(read.body.evidence.coverage.complete).toBe(false);
  });

  it("rechecks expiry and authorization during publication and retrieval", async () => {
    const expired = setup();
    expired.store.beforePublish = async () => expired.advance(61);
    const accepted = await post(expired.app);
    expect(expired.store.rows.get(accepted.body.requestId)?.evidence).toBeNull();
    expect((await request(expired.app).get(`${path}/${accepted.body.requestId}`).set("x-test-actor", "devops")).status).toBe(410);

    const revoked = setup();
    revoked.store.beforePublish = async () => { revoked.permissions.delete("board-test:review-preflight:run"); };
    const rejected = await post(revoked.app);
    expect(revoked.store.rows.get(rejected.body.requestId)?.evidence).toBeNull();

    const readRevoked = setup();
    const published = await post(readRevoked.app);
    readRevoked.store.beforeGet = async () => { readRevoked.permissions.delete(`${devops.id}:review-preflight:evidence-read`); };
    expect((await request(readRevoked.app).get(`${path}/${published.body.requestId}`).set("x-test-actor", "devops")).status).toBe(403);
  });

  it("stops on revocation, denies POST and GET, and retains the pending reservation", async () => {
    const fixture = setup({ revokeAfterFirstRead: true });
    const { app, store, permissions } = fixture;
    const accepted = await post(app);
    expect(accepted.body.status).toBe("pending");
    expect(fixture.reads).toBe(1);
    expect(store.rows.size).toBe(1);
    const id = accepted.body.requestId;
    expect(store.rows.get(id)?.evidence).toBeNull();
    expect((await post(app, "board", "second_request_key_123")).status).toBe(403);
    permissions.delete(`${devops.id}:review-preflight:evidence-read`);
    expect((await request(app).get(`${path}/${id}`).set("x-test-actor", "devops")).status).toBe(403);
    expect(store.rows.has(id)).toBe(true);
  });

  it("expires before another source read and does not replay an uncertain request", async () => {
    const fixture = setup({ expireAfterFirstRead: true });
    const { app, store, advance } = fixture;
    const accepted = await post(app);
    const initialId = accepted.body.requestId;
    expect(fixture.reads).toBe(1);
    expect(store.rows.get(initialId)?.evidence).toBeNull();
    advance(61);
    const replay = await post(app);
    expect(replay.body.requestId).toBe(initialId);
    expect(store.rows.size).toBe(1);
    const anotherKey = await post(app, "board", "another_request_key_123");
    expect(anotherKey.status).toBe(409);
    expect(anotherKey.body.error).toBe("pending_unresolved");
    expect(anotherKey.headers["retry-after"]).toBeUndefined();
  });
});
