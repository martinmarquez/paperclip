import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issueRelations, issueThreadInteractions, issues } from "@paperclipai/db";
import { createPostgresRunDispatchAdapter } from "../modules/run-dispatch/adapters/postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
type QuestionCase = {
  name: string; allowed?: boolean; status?: "expired"; wrongAddressee?: boolean;
  resolver?: "human_only"; unaddressed?: boolean; wrongSource?: boolean; paused?: boolean;
};
const cases: QuestionCase[] = [
  { name: "valid addressed question", allowed: true }, { name: "expired question", status: "expired" },
  { name: "different addressee", wrongAddressee: true }, { name: "human-only question", resolver: "human_only" },
  { name: "unaddressed question", unaddressed: true }, { name: "spoofed source", wrongSource: true },
  { name: "paused recipient", paused: true },
];

describePostgres("heartbeat attention on dependency-blocked tasks", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  let directory: string;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-blocked-question-");
    db = createDb(temp.connectionString);
    directory = mkdtempSync(join(tmpdir(), "paperclip-question-only-"));
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });
    heartbeat = heartbeatService(db, { runtimeEnv: {} });
  }, 20_000);
  afterAll(async () => {
    await temp?.cleanup();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it.each(cases)("$name preserves the delivery gate", async (tc) => {
    const companyId = randomUUID(), owner = randomUUID(), agent = randomUUID();
    const issue = randomUUID(), child = randomUUID(), card = randomUUID(), user = `paperclip-id:${randomUUID()}`;
    const marker = join(directory, card);
    await db.insert(companies).values({ id: companyId, name: "Question regression", issuePrefix: `BQ${companyId.slice(0, 6)}`, requireBoardApprovalForNewAgents: false });
    await db.insert(authUsers).values({ id: user, name: "Synthetic responsible owner", email: `${randomUUID()}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: user, membershipRole: "owner", status: "active" });
    await db.insert(agents).values([
      { id: owner, companyId, name: "Owner", role: "ceo", status: "idle", adapterType: "process", adapterConfig: { command: "/usr/bin/true" }, runtimeConfig: {}, permissions: {} },
      { id: agent, companyId, name: "Question recipient", role: "engineer", reportsTo: owner, status: tc.paused ? "paused" : "idle", adapterType: "process", adapterConfig: {
        command: process.execPath, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'question-only')`], cwd: directory,
      }, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(issues).values([
      { id: issue, companyId, title: tc.name, status: "blocked", priority: "medium", assigneeAgentId: owner, responsibleUserId: user, createdByUserId: user },
      { id: child, companyId, title: "Unresolved deliverable", status: "in_progress", priority: "medium", assigneeAgentId: owner },
    ]);
    await db.insert(issueRelations).values({ companyId, issueId: child, relatedIssueId: issue, type: "blocks" });
    await db.insert(issueThreadInteractions).values({ id: card, companyId, issueId: issue, kind: "ask_user_questions", status: tc.status ?? "pending", effectiveResolverPolicy: tc.resolver ?? "anyone", addresseeAgentId: tc.unaddressed ? null : tc.wrongAddressee ? owner : agent, createdByAgentId: owner, continuationPolicy: "wake_assignee", payload: { version: 1, questions: [{ id: "position", prompt: "Synthetic question?", selectionMode: "single", options: [{ id: "ok", label: "Reviewed" }] }] } });
    const wake = () => heartbeat.wakeup(agent, {
      source: "automation", triggerDetail: "system", reason: "interaction_pending",
      payload: { issueId: issue, interactionId: card, interactionKind: "ask_user_questions", mutation: "interaction" },
      requestedByActorType: "agent", requestedByActorId: owner,
      contextSnapshot: { issueId: issue, taskId: issue, interactionId: card, interactionKind: "ask_user_questions", source: tc.wrongSource ? "untrusted.caller" : "issue.interaction.created", wakeReason: "interaction_pending" },
    });
    if (tc.paused) {
      await expect(wake()).rejects.toMatchObject({ status: 409, details: { agentStatus: "paused" } });
    } else {
      const run = await wake();
      if (tc.allowed) {
        assert(run);
        let latest = run;
        for (let n = 0; n < 250 && !["succeeded", "failed", "cancelled", "timed_out"].includes(latest.status); n++) {
          await new Promise(resolve => setTimeout(resolve, 40));
          const refreshed = await heartbeat.getRun(run.id);
          assert(refreshed); latest = refreshed;
        }
        expect(latest.status, latest.error ?? undefined).toBe("succeeded");
        expect(latest.contextSnapshot?.dependencyBlockedInteraction).toBe(true);
        expect(existsSync(marker)).toBe(true);
      } else {
        expect(run).toBeNull();
      }
    }
    if (!tc.allowed) expect(existsSync(marker)).toBe(false);
    const source = await db.select().from(issues).then(rows => rows.find(row => row.id === issue));
    expect(source).toMatchObject({ status: "blocked", assigneeAgentId: owner });
  }, 15_000);
  it.each([false, true])("revalidates the blocked owner's question under the card lock (expire=%s)", async (expire) => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const child = randomUUID(), card = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Dispatch race", issuePrefix: `QR${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Owner", role: "engineer", status: "idle", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(issues).values([
      { id: issueId, companyId, title: "Blocked owner", status: "blocked", assigneeAgentId: agentId },
      { id: child, companyId, title: "Unresolved child", status: "in_progress", assigneeAgentId: agentId },
    ]);
    await db.insert(issueRelations).values({ companyId, issueId: child, relatedIssueId: issueId, type: "blocks" });
    await db.insert(issueThreadInteractions).values({ id: card, companyId, issueId, kind: "ask_user_questions", status: "pending", effectiveResolverPolicy: "anyone", addresseeAgentId: agentId, createdByAgentId: agentId, payload: { version: 1, questions: [] } });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "queued", contextSnapshot: { issueId, interactionId: card, source: "issue.interaction.created", wakeReason: "interaction_pending" } });
    let release!: () => void, locked!: () => void;
    const ready = new Promise<void>(resolve => { locked = resolve; });
    const finish = new Promise<void>(resolve => { release = resolve; });
    const holder = expire ? db.transaction(async tx => {
      await tx.execute(sql`update issue_thread_interactions set status='expired' where id=${card}`);
      locked(); await finish;
    }) : null;
    if (holder) await ready;
    let settled = false;
    const check = createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({ runId, companyId, expectedStatus: "queued", now: new Date() }).finally(() => { settled = true; });
    if (holder) {
      try { await new Promise(resolve => setTimeout(resolve, 100)); expect(settled).toBe(false); }
      finally { release(); await holder; }
    }
    const result = await check;
    expect(result.outcome).toBe(expire ? "cancelled" : "not_stale");
    if (expire) expect(result).toMatchObject({ errorCode: "issue_dependencies_blocked" });
    expect(await db.select().from(issues).then(rows => rows.find(row => row.id === issueId))).toMatchObject({ status: "blocked", assigneeAgentId: agentId });
  });

});
