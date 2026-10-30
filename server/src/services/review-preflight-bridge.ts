import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

// REN-4950: this contract has no production store, Board reader, host reader, or route registration.
// A later activation must supply and review all three adapters independently.
export type BridgeScope = {
  companyId: string;
  prNumber: number;
  reviewerIds: readonly [string, string];
  readerAgentIds: readonly [string, string];
  operatorUserIds: readonly string[];
};

const scopeSchema = z.strictObject({
  companyId: z.uuid(), prNumber: z.number().int().positive(),
  reviewerIds: z.tuple([z.uuid(), z.uuid()]),
  readerAgentIds: z.tuple([z.uuid(), z.uuid()]),
  operatorUserIds: z.array(z.string().min(1)).min(1),
});

export function validScope(scope: BridgeScope): boolean {
  const parsed = scopeSchema.safeParse(scope);
  if (!parsed.success) return false;
  const ids = [...scope.reviewerIds, ...scope.readerAgentIds];
  return new Set(ids).size === ids.length;
}

export const subjectSchema = z.strictObject({
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  base: z.string().regex(/^[0-9a-f]{40}$/),
  tree: z.string().regex(/^[0-9a-f]{40}$/),
  bundleHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type Subject = z.infer<typeof subjectSchema>;

const observationSchema = z.strictObject({
  observedAt: z.string().datetime({ offset: true }),
  sourceRevision: z.string().min(1).max(200),
  sourceHash: z.string().regex(/^[0-9a-f]{64}$/),
  status: z.enum(["PASS", "FAIL", "UNKNOWN"]),
});
export type Observation = z.infer<typeof observationSchema>;

const keySchema = z.object({
  id: z.string().min(1).max(200),
  scope: z.string().min(1).max(100),
  createdAt: z.string().datetime({ offset: true }),
  revokedAt: z.string().datetime({ offset: true }).nullable(),
});
const sourceSchema = z.object({
  configuration: z.object({ adapterType: z.string().max(100), cwd: z.string().max(500), sandbox: z.string().max(100) }),
  keys: z.array(keySchema).max(50),
  profile: z.object({ profileNames: z.array(z.string().max(100)).max(50), bindingNames: z.array(z.string().max(100)).max(50) }),
  environment: z.object({ names: z.array(z.string().max(100)).max(50), drivers: z.array(z.string().max(100)).max(50) }),
  audit: z.object({ events: z.array(z.object({ id: z.string().max(200), actorId: z.string().max(200), action: z.string().max(200) })).max(50), nextCursor: z.string().max(500).nullable() }),
});
export type SourceKind = keyof z.infer<typeof sourceSchema>;
const manifestSchema = z.object({
  engine: z.string().min(1).max(100),
  policyId: z.string().min(1).max(200),
  policyVersion: z.string().min(1).max(200),
  uid: z.number().int().nonnegative(),
  gid: z.number().int().nonnegative(),
  cwd: z.string().min(1).max(500),
  mounts: z.array(z.object({ path: z.string().max(500), access: z.enum(["ro", "rw", "deny"]) })).max(100),
  scratch: z.string().min(1).max(500),
  egress: z.enum(["denied", "allowlisted", "unrestricted"]),
});

export type Principal = {
  type: "board" | "agent";
  id: string;
  source: string;
  keyId?: string | null;
};

export type Reservation = {
  id: string;
  companyId: string;
  actorId: string;
  idempotencyKey: string;
  subject: Subject;
  createdAt: string;
  expiresAt: string;
  status: "pending" | "hold";
  evidence: Evidence | null;
};

export type ReserveResult =
  | { kind: "created" | "existing"; reservation: Reservation }
  | { kind: "conflict" }
  | { kind: "pending_unresolved" }
  | { kind: "rate_limited"; retryAfterSeconds: number };

export interface ReservationStore {
  // Durable and atomic across processes: unique (company, actor, key), immutable subject,
  // one extraction/company/hour, and at most one pending extraction/company regardless of age.
  // Keep pending reservations and idempotency tombstones through restart; timeouts are uncertain,
  // never permission to replay a privileged read. An in-memory store is test-only.
  reserve(input: Omit<Reservation, "status" | "evidence">, signal?: AbortSignal): Promise<ReserveResult>;
  get(companyId: string, requestId: string, signal?: AbortSignal): Promise<Reservation | null>;
  // A production adapter must serialize this guard with the pending row and current ACL
  // revision in one transaction. Reject expiry, revocation, cross-company/actor writes,
  // and second publication. Do not persist evidence when the guard returns false.
  publishHold(input: { requestId: string; companyId: string; actorId: string; evidence: Evidence },
    guard: (signal: AbortSignal) => Promise<boolean>, signal?: AbortSignal): Promise<boolean>;
}

export interface BoardHostReader {
  // The adapter supplies authority server-side. Audit must filter both scoped reviewer IDs.
  // No caller-controlled URL, path, filter, or credential.
  read(kind: SourceKind, agentId: string | null, cursor: string | null, signal: AbortSignal): Promise<unknown>;
  readManifest(agentId: string, signal: AbortSignal): Promise<unknown>;
}

export interface BridgeDependencies {
  enabled: boolean;
  scope: BridgeScope;
  subject: Subject | null; // Resolved from the protected integration owner, never from POST body.
  store: ReservationStore;
  reader?: BoardHostReader; // No production adapter is included in this patch.
  can: (principal: Principal, permission: "review-preflight:run" | "review-preflight:evidence-read", companyId: string, requestId?: string, signal?: AbortSignal) => Promise<boolean>;
  verifyOrigin: (origin: string | undefined) => boolean;
  now?: () => Date;
  ioLimits?: { totalMs: number; callMs: number }; // Test override; production adapter must honor AbortSignal.
}

export type Evidence = {
  schemaVersion: 1;
  requestId: string;
  prNumber: number;
  subject: Subject;
  principalId: string;
  reviewerIds: readonly string[];
  observations: Record<string, Observation>;
  projections: Record<string, unknown>;
  coverage: { auditPages: number; auditPaginationComplete: boolean; auditCoverageVerified: false;
    sourcesComplete: boolean; manifestComplete: boolean; complete: false };
  manifest: Record<string, { observation: Observation; data: unknown | null }>;
  attestation: { status: "UNKNOWN"; reason: "production_attestation_unavailable" };
  decision: "HOLD";
  dispatchAllowed: false;
  diagnosticOnly: true;
  contentHash: string;
};

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

// PostgreSQL jsonb reorders object keys. Hash the same representation before and after storage.
export const hashEvidence = (body: Omit<Evidence, "contentHash">) => sha256(canonicalJson(body));

const fresh = (observedAt: string, at: Date) => {
  const age = at.getTime() - Date.parse(observedAt);
  return age >= 0 && age <= 15 * 60_000;
};

export function evidenceFresh(evidence: Evidence, at: Date): boolean {
  return [...Object.values(evidence.observations), ...Object.values(evidence.manifest).map((item) => item.observation)]
    .every((observation) => fresh(observation.observedAt, at));
}

function parseObservation(raw: unknown, at: Date): Observation {
  const parsed = observationSchema.safeParse(raw);
  if (!parsed.success) return { observedAt: at.toISOString(), sourceRevision: "unknown", sourceHash: "0".repeat(64), status: "UNKNOWN" };
  const safe = { ...parsed.data, sourceRevision: "redacted" };
  return fresh(parsed.data.observedAt, at) ? safe : { ...safe, status: "UNKNOWN" };
}

// Evidence contains structure and counts, never free-form values or pagination cursors.
// Real adapters must additionally produce secret-free DTOs before this boundary.
function redactStrings(value: unknown): unknown {
  if (typeof value === "string") return "[redacted]";
  if (Array.isArray(value)) return value.map(redactStrings);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "nextCursor")
      .map(([key, item]) => [key, redactStrings(item)]));
  }
  return value;
}

function sanitize(kind: SourceKind, raw: unknown): { data: unknown; nextCursor: string | null } | null {
  const parsed = sourceSchema.shape[kind].safeParse(raw);
  if (!parsed.success) return null;
  const nextCursor = kind === "audit" ? (parsed.data as { nextCursor: string | null }).nextCursor : null;
  return { data: redactStrings(parsed.data), nextCursor };
}

export function fixedResourcePaths(scope: BridgeScope) {
  const company = `/api/companies/${scope.companyId}`;
  return [
    ...scope.reviewerIds.map((id) => `/api/agents/${id}/configuration`),
    ...scope.reviewerIds.map((id) => `/api/agents/${id}/keys`),
    ...scope.reviewerIds.map((id) => `${company}/tools/profiles/effective/agents/${id}`),
    `${company}/environments`,
    `${company}/audit/agent-actions`,
  ];
}

export async function authorizeRun(deps: BridgeDependencies, principal: Principal, companyId: string, signal?: AbortSignal): Promise<boolean> {
  return deps.enabled && validScope(deps.scope) && companyId === deps.scope.companyId && principal.type === "board"
    && principal.source === "session" && !principal.keyId && deps.scope.operatorUserIds.includes(principal.id)
    && await deps.can(principal, "review-preflight:run", companyId, undefined, signal);
}

export async function authorizeRead(deps: BridgeDependencies, principal: Principal, companyId: string, requestId: string, signal?: AbortSignal): Promise<boolean> {
  return deps.enabled && validScope(deps.scope) && companyId === deps.scope.companyId && principal.type === "agent"
    && principal.source === "agent_jwt" && !principal.keyId
    && deps.scope.readerAgentIds.includes(principal.id as typeof deps.scope.readerAgentIds[number])
    && !deps.scope.reviewerIds.includes(principal.id as typeof deps.scope.reviewerIds[number])
    && await deps.can(principal, "review-preflight:evidence-read", companyId, requestId, signal);
}

export async function reserveRequest(deps: BridgeDependencies, principal: Principal, subject: Subject, key: string, signal?: AbortSignal): Promise<ReserveResult> {
  const at = (deps.now ?? (() => new Date()))();
  return deps.store.reserve({
    id: randomUUID(), companyId: deps.scope.companyId, actorId: principal.id,
    idempotencyKey: key, subject, createdAt: at.toISOString(),
    expiresAt: new Date(at.getTime() + 60 * 60_000).toISOString(),
  }, signal);
}

export async function boundedOperation<T>(parent: AbortSignal, limitMs: number, read: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (parent.aborted) throw new Error("preflight_aborted");
  const controller = new AbortController();
  const abort = () => controller.abort();
  parent.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, limitMs);
  try {
    return await new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(new Error("preflight_operation_uncertain"));
      controller.signal.addEventListener("abort", onAbort, { once: true });
      Promise.resolve().then(() => {
        if (controller.signal.aborted) throw new Error("preflight_operation_uncertain");
        return read(controller.signal);
      }).then(
        (value) => { controller.signal.removeEventListener("abort", onAbort); resolve(value); },
        (error) => { controller.signal.removeEventListener("abort", onAbort); reject(error); },
      );
    });
  } finally {
    clearTimeout(timer);
    parent.removeEventListener("abort", abort);
    controller.abort();
  }
}

export async function collectDiagnostic(deps: BridgeDependencies, principal: Principal, reservation: Reservation, parent?: AbortSignal): Promise<Evidence | null> {
  if (parent?.aborted) return null;
  const observations: Record<string, Observation> = {};
  const projections: Record<string, unknown> = {};
  const manifest: Evidence["manifest"] = {};
  let auditPages = 0;
  let auditPaginationComplete = true;
  let sourcesComplete = true;
  // A parsed manifest is not proof of applied policy, equivalent negatives, or admission lineage.
  const manifestComplete = false;
  const now = deps.now ?? (() => new Date());
  if (!deps.reader) return unknownEvidence(deps, principal, reservation);
  const reader = deps.reader;
  const limits = deps.ioLimits ?? { totalMs: 60_000, callMs: 5_000 };
  if (!Number.isFinite(limits.totalMs) || !Number.isFinite(limits.callMs)
    || limits.totalMs <= 0 || limits.callMs <= 0) return null;
  const totalMs = Math.min(limits.totalMs, 60_000);
  const callMs = Math.min(limits.callMs, 5_000);
  const total = new AbortController();
  const onParentAbort = () => total.abort();
  parent?.addEventListener("abort", onParentAbort, { once: true });
  if (parent?.aborted) total.abort();
  const totalTimer = setTimeout(() => total.abort(), totalMs);
  const active = async () => !total.signal.aborted && now().getTime() < Date.parse(reservation.expiresAt)
    && await boundedOperation(total.signal, callMs,
      (signal) => authorizeRun(deps, principal, reservation.companyId, signal));

  try {

  for (const kind of ["configuration", "keys", "profile", "environment", "audit"] as const) {
    const ids = kind === "environment" || kind === "audit" ? [null] : deps.scope.reviewerIds;
    for (const id of ids) {
      let cursor: string | null = null;
      let pages = 0;
      do {
        if (!await active()) return null; // Revocation prevents another read and any publication.
        const raw = await boundedOperation(total.signal, callMs,
          (signal) => reader.read(kind, id, cursor, signal));
        if (!await active()) return null;
        const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
        const safe = sanitize(kind, value.data);
        const observation = parseObservation(value.observation, now());
        const pathKey = `${kind}:${id ?? "company"}:${pages}`;
        observations[pathKey] = safe === null ? { ...observation, status: "UNKNOWN" } : observation;
        if (safe !== null) projections[pathKey] = safe.data;
        if (safe === null || observation.status !== "PASS") sourcesComplete = false;
        if (kind !== "audit") break;
        auditPages++;
        pages++;
        cursor = safe?.nextCursor ?? null;
        if (safe === null || (cursor && pages >= 100)) { auditPaginationComplete = false; break; }
      } while (cursor);
    }
  }

  for (const id of deps.scope.reviewerIds) {
    if (!await active()) return null;
    const raw = await boundedOperation(total.signal, callMs, (signal) => reader.readManifest(id, signal));
    if (!await active()) return null;
    const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const data = manifestSchema.safeParse(value.data);
    const observation = parseObservation(value.observation, now());
    manifest[id] = { observation: { ...observation, status: "UNKNOWN" },
      data: data.success ? redactStrings(data.data) : null };
  }
  if (!await active()) return null;
  // No production attestor is wired; a parsed result is always diagnostic.
  const evidenceWithoutHash = {
    schemaVersion: 1 as const, requestId: reservation.id, prNumber: deps.scope.prNumber, subject: reservation.subject,
    principalId: principal.id, reviewerIds: deps.scope.reviewerIds,
    observations, projections,
    coverage: { auditPages, auditPaginationComplete, auditCoverageVerified: false as const,
      sourcesComplete, manifestComplete, complete: false as const }, manifest,
    attestation: { status: "UNKNOWN" as const, reason: "production_attestation_unavailable" as const },
    decision: "HOLD" as const, dispatchAllowed: false as const, diagnosticOnly: true as const,
  };
  if (!await active()) return null;
  const evidence = { ...evidenceWithoutHash, contentHash: hashEvidence(evidenceWithoutHash) };
  return evidenceFresh(evidence, now()) ? evidence : null;
  } catch {
    // A timed-out adapter may still have provider effects; leave the durable reservation pending.
    return null;
  } finally {
    clearTimeout(totalTimer);
    parent?.removeEventListener("abort", onParentAbort);
    total.abort();
  }
}

function unknownEvidence(deps: BridgeDependencies, principal: Principal, reservation: Reservation): Evidence {
  const evidenceWithoutHash = {
    schemaVersion: 1 as const, requestId: reservation.id, prNumber: deps.scope.prNumber,
    subject: reservation.subject, principalId: principal.id, reviewerIds: deps.scope.reviewerIds,
    observations: {}, projections: {}, manifest: {},
    coverage: { auditPages: 0, auditPaginationComplete: false, auditCoverageVerified: false as const,
      sourcesComplete: false, manifestComplete: false, complete: false as const },
    attestation: { status: "UNKNOWN" as const, reason: "production_attestation_unavailable" as const },
    decision: "HOLD" as const, dispatchAllowed: false as const, diagnosticOnly: true as const,
  };
  return { ...evidenceWithoutHash, contentHash: hashEvidence(evidenceWithoutHash) };
}
