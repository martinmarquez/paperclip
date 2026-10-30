import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import { issueService } from "../services/issues.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping reassignment PostgreSQL tests: ${support.reason}`);

describePostgres("pending task runs at the ownership boundary", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("reassignment-pending-");
    db = createDb(temporary.connectionString);
  }, 60_000);
  afterAll(async () => { await temporary?.cleanup(); });

  async function fixture(issueId = randomUUID()) {
    const companyId = randomUUID(), agentId = randomUUID(), nextId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Reassignment", issuePrefix: `R${companyId.slice(0, 6)}`,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "test-board" });
    await db.insert(agents).values([agentId, nextId].map(id => ({ id, companyId, name: id,
      role: "engineer", status: "idle", adapterType: "process", adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true } } })));
    await db.insert(issues).values({ id: issueId, companyId, title: "Assignment only", status: "blocked", assigneeAgentId: agentId });
    const heartbeat = heartbeatService(db);
    const task = async () => (await db.select().from(issues).where(eq(issues.id, issueId)))[0]!;
    return { companyId, agentId, nextId, issueId, heartbeat, task };
  }

  async function seed(f: Awaited<ReturnType<typeof fixture>>, status: string, identity: string) {
    const id = randomUUID(), wakeupRequestId = identity === "wake" ? randomUUID() : null;
    if (wakeupRequestId) await db.insert(agentWakeupRequests).values({ id: wakeupRequestId,
      companyId: f.companyId, agentId: f.agentId, source: "automation", status: "queued",
      payload: { _paperclipWakeContext: { taskId: f.issueId } } });
    await db.insert(heartbeatRuns).values({ id, companyId: f.companyId, agentId: f.agentId, status,
      invocationSource: "automation", triggerDetail: "system", wakeupRequestId,
      nativeIssueId: identity === "native" ? f.issueId : null,
      runtimeMode: identity === "native" ? "native" : "legacy",
      // Failed legacy fixtures prove bootstrap stopped before provider work.
      resultJson: status === "failed" ? { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } : null,
      contextSnapshot: identity === "issue" ? { issueId: f.issueId } : identity === "task" ? { taskId: f.issueId } : {} });
    return id;
  }

  it.each(["queued", "running", "scheduled_retry"])("refuses service reassignment with an unlinked %s run", async status => {
    const f = await fixture(), runId = await seed(f, status, "native");
    await expect(issueService(db).update(f.issueId, { assigneeAgentId: f.nextId }))
      .rejects.toMatchObject({ details: { code: "issue_reassignment_stop_unconfirmed", runId } });
    expect((await f.task()).assigneeAgentId).toBe(f.agentId);
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, runId));
    await issueService(db).update(f.issueId, { assigneeAgentId: f.nextId });
    expect(await f.task()).toMatchObject({ assigneeAgentId: f.nextId, status: "blocked", statusVersion: 1 });
  });

  it.each(["native", "issue", "task", "wake"])("finds a pending run by %s identity without an issue execution pointer", async identity => {
    const f = await fixture(), runId = await seed(f, "scheduled_retry", identity);
    expect(await f.heartbeat.getActiveRunForAgent(f.agentId, { companyId: f.companyId, issueId: f.issueId, includePending: true }))
      .toMatchObject({ id: runId, status: "scheduled_retry" });
    await expect(issueService(db).update(f.issueId, { assigneeAgentId: f.nextId })).rejects.toThrow();
  });

  it("keeps native identity authoritative and preserves other tasks, agents and companies", async () => {
    const f = await fixture(), other = await fixture();
    const conflicted = await seed(f, "queued", "issue");
    await db.update(heartbeatRuns).set({ nativeIssueId: other.issueId }).where(eq(heartbeatRuns.id, conflicted));
    await db.update(issues).set({ executionRunId: conflicted }).where(eq(issues.id, f.issueId));
    await seed(other, "scheduled_retry", "native");
    const nextRun = randomUUID();
    await db.insert(heartbeatRuns).values({ id: nextRun, companyId: f.companyId, agentId: f.nextId,
      nativeIssueId: f.issueId, status: "queued", invocationSource: "automation", triggerDetail: "system" });
    expect(await f.heartbeat.getActiveRunForAgent(f.agentId, { companyId: f.companyId, issueId: f.issueId,
      executionRunId: conflicted, includePending: true })).toBeNull();
    await issueService(db).update(f.issueId, { assigneeAgentId: f.nextId });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, conflicted)))[0]?.status).toBe("queued");
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, nextRun)))[0]?.status).toBe("queued");
  });

  it("uses the execution pointer for an unscoped session key without treating that key as an issue", async () => {
    const f = await fixture(), runId = await seed(f, "queued", "none");
    await db.update(heartbeatRuns).set({ contextSnapshot: { taskId: "daily-summary-session" } }).where(eq(heartbeatRuns.id, runId));
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, f.issueId));
    expect(await f.heartbeat.getActiveRunForAgent(f.agentId, { companyId: f.companyId, issueId: f.issueId,
      executionRunId: runId, includePending: true })).toMatchObject({ id: runId });
    await expect(issueService(db).update(f.issueId, { assigneeAgentId: f.nextId })).rejects.toThrow();
  });

  it("preserves a live checkout when its separate execution pointer was cleared", async () => {
    const f = await fixture(), checkout = await seed(f, "running", "none");
    await db.update(issues).set({ checkoutRunId: checkout, executionRunId: null }).where(eq(issues.id, f.issueId));
    expect(await f.heartbeat.getActiveRunForAgent(f.agentId, { companyId: f.companyId, issueId: f.issueId,
      executionRunId: null, checkoutRunId: checkout, includePending: true })).toMatchObject({ id: checkout });
    await expect(issueService(db).update(f.issueId, { assigneeAgentId: f.nextId }))
      .rejects.toMatchObject({ details: { code: "issue_reassignment_stop_unconfirmed", runId: checkout } });
    expect(await f.task()).toMatchObject({ assigneeAgentId: f.agentId, checkoutRunId: checkout });
  });

  it("recognizes UUIDv7 aliases with uppercase and surrounding whitespace", async () => {
    const f = await fixture("019a8cdb-1234-7a12-8abc-0123456789ab");
    const runId = await seed(f, "scheduled_retry", "task");
    const alias = `\t\n\u00a0${f.issueId.toUpperCase()}\ufeff\r\n`;
    await db.update(heartbeatRuns).set({ contextSnapshot: { taskId: alias } }).where(eq(heartbeatRuns.id, runId));
    expect(await f.heartbeat.getActiveRunForAgent(f.agentId, { companyId: f.companyId,
      issueId: f.issueId, includePending: true })).toMatchObject({ id: runId });
    await expect(issueService(db).update(f.issueId, { assigneeAgentId: f.nextId })).rejects.toThrow();
    const source = await seed(f, "failed", "task");
    await db.update(heartbeatRuns).set({ contextSnapshot: { taskId: alias } }).where(eq(heartbeatRuns.id, source));
    const retry = await f.heartbeat.scheduleBoundedRetry(source, { delayMs: 60_000 });
    expect(retry).toMatchObject({ outcome: "scheduled" });
    if (retry.outcome === "scheduled") expect(retry.run.contextSnapshot?.issueId).toBe(f.issueId);
  });

  it("retains a non-UUID task-session key on an unscoped failure retry", async () => {
    const f = await fixture(), runId = await seed(f, "failed", "none");
    await db.update(heartbeatRuns).set({ contextSnapshot: { taskId: "daily-summary-session" } }).where(eq(heartbeatRuns.id, runId));
    const retry = await f.heartbeat.scheduleBoundedRetry(runId, { delayMs: 60_000 });
    expect(retry).toMatchObject({ outcome: "scheduled", run: { contextSnapshot: { taskId: "daily-summary-session" } } });
    if (retry.outcome === "scheduled") expect(retry.run.contextSnapshot).not.toHaveProperty("issueId");
  });

  it("fences a retry that appears after the stop preflight while the task row is locked", async () => {
    const f = await fixture();
    let transfer!: ReturnType<ReturnType<typeof issueService>["update"]>;
    await db.transaction(async tx => {
      await tx.select().from(issues).where(eq(issues.id, f.issueId)).for("update");
      transfer = issueService(db).update(f.issueId, { assigneeAgentId: f.nextId });
      await tx.insert(heartbeatRuns).values({ id: randomUUID(), companyId: f.companyId, agentId: f.agentId,
        nativeIssueId: f.issueId, status: "scheduled_retry", invocationSource: "automation", triggerDetail: "system" });
    });
    await expect(transfer).rejects.toThrow("Stop the previous owner's task executions");
    expect((await f.task()).assigneeAgentId).toBe(f.agentId);
  });

  it("does not insert a generic failure retry after ownership changes under the scheduler's issue lock", async () => {
    const f = await fixture(), source = await seed(f, "failed", "native");
    let scheduled!: ReturnType<ReturnType<typeof heartbeatService>["scheduleBoundedRetry"]>;
    await db.transaction(async tx => {
      await tx.select().from(issues).where(eq(issues.id, f.issueId)).for("update");
      scheduled = f.heartbeat.scheduleBoundedRetry(source, { delayMs: 0 });
      await tx.update(issues).set({ assigneeAgentId: f.nextId }).where(eq(issues.id, f.issueId));
    });
    await expect(scheduled).resolves.toMatchObject({ outcome: "not_scheduled", errorCode: "issue_reassigned" });
    expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.retryOfRunId, source)))).toHaveLength(0);
  });
});
