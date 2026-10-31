import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { createReviewPreflightSqlDatabase, type Db, type PreflightSqlDatabase } from "@paperclipai/db";
import { canonicalJson, scopeSchema, subjectSchema, validScope, type BoardHostReader, type BridgeDependencies } from "./review-preflight-bridge.js";
import { createBoardSessionReader } from "./review-preflight-board-reader.js";
import { createNativePreflightAuthority } from "./review-preflight-authority.js";
import { ReviewPreflightSqlStore } from "./review-preflight-sql-store.js";

export async function readProtectedPreflightJson(path: string): Promise<unknown> {
  if (!isAbsolute(path)) throw new Error("preflight_protected_file_required");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > 128 * 1024) {
      throw new Error("preflight_protected_file_required");
    }
    const bytes = Buffer.alloc(128 * 1024 + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 128 * 1024) throw new Error("preflight_protected_file_limit");
    return JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
  } finally { await file.close(); }
}

export const preflightIntegrationSchema = z.strictObject({
  scope: scopeSchema, subject: subjectSchema,
  publicOrigin: z.url(),
  auditWindow: z.strictObject({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) }),
  hostReceiptPath: z.string().min(1),
});
type Integration = z.infer<typeof preflightIntegrationSchema>;

const receiptSchema = z.strictObject({
  subject: subjectSchema, agentId: z.uuid(), configurationHash: z.string().regex(/^[0-9a-f]{64}$/),
  observedAt: z.iso.datetime({ offset: true }),
  // A receipt describes the applied canary. It never grants reviewer admission.
  checks: z.strictObject({ sourceRead: z.literal(true), sourceWriteDenied: z.literal(true),
    outsideReadDenied: z.literal(true), scratchWrite: z.literal(true), networkDenied: z.literal(true),
    profileAcknowledged: z.literal(true) }),
  manifest: z.strictObject({ engine: z.literal("codex-native-seatbelt"), policyId: z.literal("paperclip-runner-workspace-read-only"),
    policyVersion: z.string().regex(/^[0-9a-f]{64}$/), uid: z.number().int().nonnegative(), gid: z.number().int().nonnegative(),
    cwd: z.string().min(1).max(500), scratch: z.string().min(1).max(500), egress: z.literal("denied"),
    mounts: z.array(z.strictObject({ path: z.string().max(500), access: z.enum(["ro", "rw", "deny"]) })).max(100) }),
});

export function createProtectedHostReader(config: Integration, db: PreflightSqlDatabase): BoardHostReader["readManifest"] {
  return async (agentId, signal) => {
    if (!config.scope.reviewerIds.includes(agentId)) throw new Error("preflight_source_scope");
    signal.throwIfAborted();
    const receipts = z.array(receiptSchema).length(2).parse(await readProtectedPreflightJson(config.hostReceiptPath));
    const receipt = receipts.find(item => item.agentId === agentId);
    if (!receipt || canonicalJson(receipt.subject) !== canonicalJson(config.subject)) throw new Error("preflight_host_subject");
    const age = Date.now() - Date.parse(receipt.observedAt);
    if (age < -30_000 || age > 15 * 60_000 || process.platform !== "darwin"
      || receipt.manifest.uid !== process.getuid?.() || receipt.manifest.gid !== process.getgid?.()) throw new Error("preflight_host_stale");
    const current = await db.query<{ adapter_type: string; adapter_config: unknown; runtime_config: unknown }>(
      "SELECT adapter_type, adapter_config, runtime_config FROM agents WHERE company_id = $1 AND id = $2",
      [config.scope.companyId, agentId], signal);
    if (current.rows[0]?.adapter_type !== "codex_local"
      || !z.object({ reviewReadOnly: z.literal(true) }).safeParse(current.rows[0]?.adapter_config).success) {
      throw new Error("preflight_host_enforcement_not_configured");
    }
    const hash = createHash("sha256").update(canonicalJson(current.rows[0] ?? null)).digest("hex");
    if (hash !== receipt.configurationHash) throw new Error("preflight_host_configuration_changed");
    signal.throwIfAborted();
    return { data: receipt.manifest, observation: { observedAt: receipt.observedAt,
      sourceRevision: "native-host-canary", sourceHash: createHash("sha256").update(canonicalJson(receipt)).digest("hex"), status: "PASS" } };
  };
}

// Startup opt-in uses the native DB and the requesting Board session. No stored Board credential.
export async function loadReviewPreflightIntegration(db: Db, port: number, path = process.env.PAPERCLIP_REVIEW_PREFLIGHT_CONFIG): Promise<BridgeDependencies | undefined> {
  if (!path) return undefined;
  const config = preflightIntegrationSchema.parse(await readProtectedPreflightJson(path));
  const origin = new URL(config.publicOrigin);
  if (!validScope(config.scope) || origin.origin !== config.publicOrigin || origin.protocol !== "https:"
    || !isAbsolute(config.hostReceiptPath) || Date.parse(config.auditWindow.from) >= Date.parse(config.auditWindow.to)
    || Date.parse(config.auditWindow.to) - Date.parse(config.auditWindow.from) > 24 * 60 * 60_000) throw new Error("preflight_integration_scope");
  const sql = createReviewPreflightSqlDatabase(db);
  const schema = await sql.query<{ ready: boolean }>("SELECT to_regclass('review_preflight_reservations') IS NOT NULL AND to_regclass('review_preflight_company_locks') IS NOT NULL AS ready");
  if (schema.rows[0]?.ready !== true) throw new Error("preflight_native_migration_required");
  const authority = createNativePreflightAuthority(sql, config.subject);
  const readManifest = createProtectedHostReader(config, sql);
  return { enabled: true, scope: config.scope, subject: config.subject,
    store: new ReviewPreflightSqlStore(sql, authority.publicationAuthority), can: authority.can,
    verifyOrigin: value => value === config.publicOrigin,
    readerForSession: cookie => createBoardSessionReader({ scope: config.scope,
      internalOrigin: `http://127.0.0.1:${port}`, auditWindow: config.auditWindow, cookie, readManifest }),
  };
}
