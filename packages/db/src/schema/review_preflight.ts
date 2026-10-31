import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const reviewPreflightCompanyLocks = pgTable("review_preflight_company_locks", {
  companyId: uuid("company_id").primaryKey().references(() => companies.id),
});

export const reviewPreflightReservations = pgTable("review_preflight_reservations", {
  id: uuid("id").primaryKey(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  actorId: text("actor_id").notNull(), idempotencyKey: text("idempotency_key").notNull(),
  sha: text("sha").notNull(), baseSha: text("base_sha").notNull(), treeSha: text("tree_sha").notNull(),
  bundleHash: text("bundle_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  status: text("status").notNull().default("pending"), evidence: jsonb("evidence"),
}, table => [
  unique("review_preflight_idempotency").on(table.companyId, table.actorId, table.idempotencyKey),
  uniqueIndex("review_preflight_one_pending_per_company").on(table.companyId).where(sql`${table.status} = 'pending'`),
  index("review_preflight_recent_per_company").on(table.companyId, table.createdAt.desc()),
  check("review_preflight_actor_length", sql`length(${table.actorId}) BETWEEN 1 AND 200`),
  check("review_preflight_key_format", sql`${table.idempotencyKey} ~ '^[A-Za-z0-9_-]{16,128}$'`),
  check("review_preflight_sha_format", sql`${table.sha} ~ '^[0-9a-f]{40}$'`),
  check("review_preflight_base_format", sql`${table.baseSha} ~ '^[0-9a-f]{40}$'`),
  check("review_preflight_tree_format", sql`${table.treeSha} ~ '^[0-9a-f]{40}$'`),
  check("review_preflight_bundle_format", sql`${table.bundleHash} ~ '^[0-9a-f]{64}$'`),
  check("review_preflight_status", sql`${table.status} IN ('pending', 'hold')`),
  check("review_preflight_expiry", sql`${table.expiresAt} = ${table.createdAt} + interval '1 hour'`),
  check("review_preflight_evidence_state", sql`(${table.status} = 'pending' AND ${table.evidence} IS NULL) OR (${table.status} = 'hold' AND ${table.evidence} IS NOT NULL)`),
]);
