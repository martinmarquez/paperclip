import type { PreflightSqlDatabase, PreflightSqlExecutor } from "@paperclipai/db";
import type { BridgeDependencies, Principal, Subject } from "./review-preflight-bridge.js";
import type { PublicationAuthority } from "./review-preflight-sql-store.js";

type Permission = Parameters<BridgeDependencies["can"]>[1];

// Locks use the same native rows as access-service revocation; no parallel ACL store.
async function allowed(tx: PreflightSqlExecutor, principal: Principal, permission: Permission, companyId: string,
  subject: Subject, requestId: string | undefined, signal: AbortSignal): Promise<boolean> {
  const rows = await tx.query<{ scope: Record<string, unknown> | null; now_at: string | Date }>(`
    SELECT g.scope, clock_timestamp() AS now_at
      FROM principal_permission_grants g JOIN company_memberships m
        ON m.company_id = g.company_id AND m.principal_type = g.principal_type AND m.principal_id = g.principal_id
      WHERE g.company_id = $1 AND g.principal_type = $2 AND g.principal_id = $3
        AND g.permission_key = $4 AND m.status = 'active'
        AND ($2 <> 'user' OR m.membership_role IN ('owner','admin','operator','member'))
      FOR SHARE OF g, m`, [companyId, principal.type === "board" ? "user" : "agent", principal.id, permission], signal);
  const row = rows.rows[0];
  const scope = row?.scope;
  if (!scope || scope.companyId !== companyId || scope.subjectSha !== subject.sha
    || typeof scope.expiresAt !== "string") return false;
  const expiry = Date.parse(scope.expiresAt);
  const now = new Date(row.now_at).getTime();
  if (!Number.isFinite(expiry) || expiry <= now || expiry > now + 60 * 60_000) return false;
  return permission === "review-preflight:run" ? !requestId
    : typeof requestId === "string" && requestId.length > 0 && scope.requestId === requestId;
}

export function createNativePreflightAuthority(db: PreflightSqlDatabase, subject: Subject): {
  can: BridgeDependencies["can"]; publicationAuthority: PublicationAuthority;
} {
  return {
    can: async (principal, permission, companyId, requestId, signal) => {
      const active = signal ?? new AbortController().signal;
      return db.transaction((tx) => allowed(tx, principal, permission, companyId, subject, requestId, active),
        { signal: active, timeoutMs: 3_000 });
    },
    publicationAuthority: (tx, row, signal) => allowed(tx,
      { type: "board", id: row.actorId, source: "session" }, "review-preflight:run", row.companyId, subject, undefined, signal),
  };
}
