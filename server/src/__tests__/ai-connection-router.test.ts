import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { createDb, companies, agents, companyMemberships, connectionGrants, plugins, aiConnectionRouterCursors, aiConnectionTaskPins, toolConnections, companySecrets, heartbeatRuns, issues, issueRecoveryActions, activityLog, agentTaskSessions, agentWakeupRequests, heartbeatRunEvents, environmentLeases } from "@paperclipai/db";
import { releaseOrphanedRouterPin } from "../services/orphaned-router-pin.js";
import { startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";
import type { AiConnectionPoolMember, AiConnectionRouterRequest, AiConnectionRouterResult, PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { aiConnectionRouterService, AiConnectionPoolExhausted, poolMemberRuntimeConfig, applyAiConnectionRouterTaskSettings } from "../services/ai-connection-router.js";
import { aiConnectionSessionCompatibilityInputs } from "../services/ai-connection-session.js";
import { projectPaperclipRunnerTaskConfig, resolvePaperclipRunnerNativeProviderInput } from "../services/native-runtime/provider-profile.js";
import { aiConnectionService } from "../services/ai-connections.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { managedAiSessionFingerprintConfig, prepareManagedAiRuntime } from "../services/ai-connection-runtime.js";
import { secretService } from "../services/secrets.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import express from "express";
import request from "supertest";
import { toolAccessRoutes } from "../routes/tool-access.js";
import { aiConnectionRoutes } from "../routes/ai-connections.js";
import { errorHandler } from "../middleware/index.js";
import { heartbeatService, buildEffectiveRunSessionConfigMetadata, resolveTaskSessionConfigFreshness } from "../services/heartbeat.js";
import { connectionIntentService } from "../services/connection-intents.js";
import { legacyExecutionNeedsReconciliation } from "../services/legacy-execution-recovery.js";
import { getServerAdapter, registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let home: string;
const companyId = randomUUID(), otherCompanyId = randomUUID(), agentId = randomUUID(), secondAgentId = randomUUID(), pluginId = randomUUID();
const pluginKey = "fixture.ai-router";
const manifest: PaperclipPluginManifestV1 = { id: pluginKey, apiVersion: 1, version: "0.1.0", displayName: "Fixture router", description: "Fixture", author: "Tests", categories: ["connector"], capabilities: ["ai.connections.route"], aiConnectionRouter: { name: "AI connection pool", description: "Use saved connections" }, entrypoints: { worker: "worker.js" } };
let members: AiConnectionPoolMember[];
const proposal = vi.fn(async (_id: string, _method: string, request: AiConnectionRouterRequest): Promise<AiConnectionRouterResult> => {
  const next = (request.memberOrder.indexOf(request.lastMemberId ?? "") + 1) % request.memberOrder.length;
  const order = request.pinnedMemberId ? [request.pinnedMemberId] : [...request.memberOrder.slice(next), ...request.memberOrder.slice(0, next)];
  const selected = order.find(id => request.candidates.some(candidate => candidate.member.id === id));
  return selected ? { kind: "selected", memberId: selected } : { kind: "unavailable", skipped: {} };
});
const worker = { isRunning: () => true, call: proposal } as unknown as PluginWorkerManager;
const defaultProposal = proposal.getMockImplementation()!;
const service = () => aiConnectionRouterService(db, worker);
const resolve = (poolId: string, taskKey: string, extra = {}) => service().resolve({ companyId, poolId, agentId, userId: "alice", adapterType: "paperclip_runner", taskKey, ...extra });
const makePool = async (config = {}) => service().save(pluginKey, { companyId, config: { name: randomUUID(), enabled: true, mode: "round_robin", thresholdPercent: 90, members, ...config } }, "alice");
beforeAll(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "paperclip-router-tests-"));
  vi.stubEnv("PAPERCLIP_HOME", home); vi.stubEnv("PAPERCLIP_INSTANCE_ID", "router-fixture");
  database = await startEmbeddedPostgresTestDatabase("paperclip-router-db-"); db = createDb(database.connectionString);
  await db.insert(companies).values([{ id: companyId, name: "Router fixture", issuePrefix: "RTF" }, { id: otherCompanyId, name: "Other", issuePrefix: "RTO" }]);
  await db.insert(agents).values([agentId, secondAgentId].map(id => ({ id, companyId, name: "Router agent", adapterType: "paperclip_runner" })));
  await db.insert(companyMemberships).values(["alice", "bob"].map(principalId => ({ companyId, principalId, principalType: "user", status: "active", membershipRole: "member" })));
  await db.insert(plugins).values({ id: pluginId, pluginKey, packageName: pluginKey, version: "0.1.0", manifestJson: manifest, status: "ready" });
  const accounts = aiConnectionService(db);
  const codex = await accounts.save(companyId, "alice", { provider: "openai", method: "api_key", ownership: "personal", name: "Codex", apiKey: "fixture", agentIds: [], allAgents: true }, "fixture-codex");
  const claude = await accounts.save(companyId, "alice", { provider: "anthropic", method: "subscription", ownership: "personal", name: "Claude", loginSessionId: "fixture", agentIds: [], allAgents: true }, "fixture-claude");
  members = [
    { id: randomUUID(), binding: { mode: "delegated", provider: "openai", method: "api_key", ...codex }, profile: { provider: "codex", model: "gpt-5.6-sol", effort: "low" } },
    { id: randomUUID(), binding: { mode: "delegated", provider: "anthropic", method: "subscription", ...claude }, profile: { provider: "acpx", acpxAgent: "claude", model: "claude-sonnet-5" } },
  ];
}, 90000);
afterAll(async () => { await database?.cleanup(); vi.unstubAllEnvs(); if (home) await rm(home, { recursive: true, force: true }); });

describe("durable, authorized connection routing", () => {
  it("defaults off and does not expose selectable pools before opt-in", async () => {
    expect((await instanceSettingsService(db).getExperimental()).enableAiConnectionRouters).toBe(false);
    expect((await service().catalog())[0]?.availability).toEqual({ available: false, reason: "Ask your instance operator to enable AI connection routing." });
    await expect(makePool()).rejects.toThrow("instance operator");
    expect(await service().selectable(companyId, "alice")).toEqual([]);
    await instanceSettingsService(db).updateExperimental({ enableAiConnectionRouters: true });
  });
  it("registers native connectors only for declared installed routers", async () => {
    const entry = (await service().catalog())[0]!;
    expect(entry.name).toBe("AI connection pool");
    expect(entry.aiConnectionRouter).toEqual({ pluginKey });
    expect(entry.availability?.available).toBe(true);
    await db.update(plugins).set({ status: "disabled" }).where(eq(plugins.id, pluginId));
    try {
      expect((await service().catalog())[0]?.availability?.available).toBe(false);
      await db.update(plugins).set({ status: "uninstalled" }).where(eq(plugins.id, pluginId));
      expect(await service().catalog()).toEqual([]);
    } finally { await db.update(plugins).set({ status: "ready" }).where(eq(plugins.id, pluginId)); }
  });
  it("native connector removal retains durable pins and ordinary updates cannot bypass pool revisions", async () => {
    const pool = await makePool(); const selected = await resolve(pool.id, "catalog-removal");
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", userId: "alice", source: "local_implicit", companyIds: [companyId], memberships: [{ companyId, status: "active", membershipRole: "owner" }] } as typeof req.actor; next(); });
    app.use("/api", toolAccessRoutes(db)); app.use("/api", aiConnectionRoutes(db)); app.use(errorHandler);
    expect((await request(app).patch(`/api/tool-connections/${pool.id}`).send({ name: "Bypass" })).status).toBe(400);
    expect((await request(app).delete(`/api/tool-connections/${pool.id}`)).status).toBe(400);
    expect((await request(app).delete(`/api/companies/${companyId}/ai-connection-pools/${pool.id}`).send({ expectedRevision: pool.revision + 1 })).status).toBe(409);
    expect((await request(app).delete(`/api/companies/${companyId}/ai-connection-pools/${pool.id}`).send({ expectedRevision: pool.revision })).status).toBe(200);
    expect((await service().list(companyId)).some(row => row.id === pool.id)).toBe(false);
    expect(await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.poolId, pool.id))).toHaveLength(1);
    expect(await resolve(pool.id, "catalog-removal", { persisted: selected })).toEqual(selected);
    expect((await db.select().from(toolConnections).where(eq(toolConnections.id, members[0]!.binding.connectionId)))[0]?.status).toBe("active");
  });
  it("requires company connection management authority on pool configuration routes", async () => {
    const app = express(); app.use(express.json());
    let actor = { type: "board", userId: "alice", source: "session", companyIds: [companyId], memberships: [{ companyId, status: "active", membershipRole: "owner" }] };
    app.use((req, _res, next) => { req.actor = actor as typeof req.actor; next(); }); app.use("/api", aiConnectionRoutes(db)); app.use(errorHandler);
    const pool = await makePool(); const url = `/api/companies/${companyId}/ai-connection-pools`;
    expect((await request(app).get(url)).status).toBe(200);
    expect((await request(app).get(`/api/companies/${otherCompanyId}/ai-connection-pools`)).status).toBe(403);
    expect((await request(app).delete(`/api/companies/${otherCompanyId}/ai-connection-pools/${pool.id}`).send({ expectedRevision: pool.revision })).status).toBe(403);
    actor = { ...actor, memberships: [{ companyId, status: "active", membershipRole: "viewer" }] };
    expect((await request(app).get(url)).status).toBe(403);
    expect((await request(app).post(url).send({ pluginKey, config: pool })).status).toBe(403);
    expect((await request(app).get(`${url}/${pool.id}/inspection`)).status).toBe(403);
    expect((await request(app).delete(`${url}/${pool.id}`).send({ expectedRevision: pool.revision })).status).toBe(403);
    actor = { type: "agent", agentId, companyId, source: "agent_jwt" } as unknown as typeof actor;
    expect((await request(app).get(url)).status).toBe(403);
    expect((await request(app).delete(`${url}/${pool.id}`).send({ expectedRevision: pool.revision })).status).toBe(403);
    actor = { type: "board", userId: "alice", source: "session", companyIds: [companyId], memberships: [{ companyId, status: "active", membershipRole: "owner" }] };
    expect((await request(app).delete(`${url}/${pool.id}`).send({ expectedRevision: pool.revision + 1 })).status).toBe(409);
    expect((await request(app).delete(`${url}/${pool.id}`).send({ expectedRevision: pool.revision })).status).toBe(200);
    expect((await request(app).get(url)).body.some((entry: { id: string }) => entry.id === pool.id)).toBe(false);
  });
  it("deletes pools without erasing pins, cursors, or admitted recovery evidence", async () => {
    const pool = await makePool(); const selected = await resolve(pool.id, "retained");
    await expect(service().remove(otherCompanyId, pool.id, pool.revision, "alice")).rejects.toThrow("not found");
    await expect(service().remove(companyId, pool.id, pool.revision + 1, "alice")).rejects.toThrow("reload before deleting");
    await service().remove(companyId, pool.id, pool.revision, "alice");
    expect((await service().list(companyId)).some(entry => entry.id === pool.id)).toBe(false);
    expect((await service().selectable(companyId, "alice")).some(entry => entry.id === pool.id)).toBe(false);
    expect(await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.poolId, pool.id))).toHaveLength(1);
    const [cursor] = await db.select().from(aiConnectionRouterCursors).where(eq(aiConnectionRouterCursors.poolId, pool.id)); expect(cursor?.version).toBe(1);
    await expect(resolve(pool.id, "new")).rejects.toThrow("choose another AI connection");
    expect(await resolve(pool.id, "retained", { persisted: selected })).toEqual(selected);
    const { name, enabled, mode, thresholdPercent, members: savedMembers } = pool;
    await expect(service().save(pluginKey, { companyId, id: pool.id, expectedRevision: pool.revision + 1, config: { name, enabled, mode, thresholdPercent, members: savedMembers } }, "alice")).rejects.toThrow("not found");
  });
  it("does not commit a selection when its pool is deleted during a proposal", async () => {
    const pool = await makePool();
    proposal.mockImplementationOnce(async () => { await service().remove(companyId, pool.id, pool.revision, "alice"); return { kind: "selected", memberId: members[0]!.id }; });
    await expect(resolve(pool.id, "deleted-during-selection")).rejects.toThrow("choose another AI connection");
    expect(await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.poolId, pool.id))).toHaveLength(0);
    const [cursor] = await db.select().from(aiConnectionRouterCursors).where(eq(aiConnectionRouterCursors.poolId, pool.id)); expect(cursor?.version).toBe(0);
  });
  it("allows cleanup while experimental routing and its plugin are disabled", async () => {
    const pool = await makePool();
    await instanceSettingsService(db).updateExperimental({ enableAiConnectionRouters: false });
    await db.update(plugins).set({ status: "disabled" }).where(eq(plugins.id, pluginId));
    try { await expect(service().remove(companyId, pool.id, pool.revision, "alice")).resolves.toEqual({ ok: true }); }
    finally { await instanceSettingsService(db).updateExperimental({ enableAiConnectionRouters: true }); await db.update(plugins).set({ status: "ready" }).where(eq(plugins.id, pluginId)); }
  });
  it("rotates new tasks across qualified backends and retains pins on turns, resets and service restart", async () => {
    const pool = await makePool();
    expect((await resolve(pool.id, "one")).memberId).toBe(members[0]!.id);
    expect((await resolve(pool.id, "two")).memberId).toBe(members[1]!.id);
    expect((await resolve(pool.id, "one", { overrides: { model: "claude-sonnet-5", modelReasoningEffort: "high" } })).memberId).toBe(members[0]!.id);
    expect((await aiConnectionRouterService(db, worker).resolve({ companyId, poolId: pool.id, agentId, userId: "alice", adapterType: "paperclip_runner", taskKey: "one" })).memberId).toBe(members[0]!.id);
    const [cursor] = await db.select().from(aiConnectionRouterCursors).where(eq(aiConnectionRouterCursors.poolId, pool.id)); expect(cursor?.version).toBe(2);
  });
  it("commits one allocation for duplicate starts and serializes concurrent tasks", async () => {
    const pool = await makePool();
    const same = await Promise.all(Array.from({ length: 8 }, () => resolve(pool.id, "duplicate")));
    expect(new Set(same.map(s => s.memberId)).size).toBe(1);
    const many = await Promise.all(Array.from({ length: 8 }, (_, n) => resolve(pool.id, `concurrent-${n}`)));
    expect(many.filter(s => s.memberId === members[0]!.id)).toHaveLength(4);
    const pins = await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.poolId, pool.id)); expect(pins).toHaveLength(9);
    const [cursor] = await db.select().from(aiConnectionRouterCursors).where(eq(aiConnectionRouterCursors.poolId, pool.id)); expect(cursor?.version).toBe(9);
  });

  let orphanFixtureNumber = 100_000;
  async function orphanedPinFixture() {
    const pool = await makePool();
    const [task] = await db.insert(issues).values({ companyId, identifier: `RTF-${orphanFixtureNumber++}`, title: "Reset routing fixture", assigneeAgentId: agentId }).returning();
    await resolve(pool.id, task.id);
    await resolve(pool.id, "preserved-other-task");
    const [pin] = await db.select().from(aiConnectionTaskPins).where(and(eq(aiConnectionTaskPins.poolId, pool.id), eq(aiConnectionTaskPins.taskKey, task.id)));
    await db.update(aiConnectionTaskPins).set({ createdAt: new Date(Date.now() - 60_000) }).where(eq(aiConnectionTaskPins.id, pin!.id));
    const [reset] = await db.insert(activityLog).values({
      companyId, actorType: "user", actorId: "alice", action: "agent.runtime_session_reset",
      entityType: "agent", entityId: agentId, details: { taskKey: task.id },
    }).returning();
    return {
      task, pool, pin: pin!, input: {
        companyId, poolId: pool.id, agentId, taskKey: task.id,
        expectedPinId: pin!.id, expectedMemberId: pin!.member.id, expectedRevision: pool.revision,
        resetActivityId: reset!.id, actorId: "alice", dryRun: false,
      },
    };
  }

  it("preflights and releases only a reset task's orphaned pin without changing its valid retry", async () => {
    const { task, pool, pin, input } = await orphanedPinFixture();
    const beforePins = await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.poolId, pool.id));
    const beforeCursor = await db.select().from(aiConnectionRouterCursors).where(eq(aiConnectionRouterCursors.poolId, pool.id));
    const [retry] = await db.insert(heartbeatRuns).values({
      companyId, agentId, status: "scheduled_retry", contextSnapshot: { issueId: task.id, aiRouterTaskKey: task.id },
      scheduledRetryAt: new Date(Date.now() + 3_600_000),
    }).returning();
    expect(await releaseOrphanedRouterPin(db, { ...input, dryRun: true })).toMatchObject({
      released: false, eligible: true, scheduledRetryIdsPreserved: [retry!.id], dispatch: "not_requested",
    });
    expect(await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.poolId, pool.id))).toEqual(beforePins);
    expect(await releaseOrphanedRouterPin(db, input)).toMatchObject({ released: true, pinId: pin.id });
    expect(await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.poolId, pool.id))).toEqual(beforePins.filter(row => row.id !== pin.id));
    expect(await db.select().from(aiConnectionRouterCursors).where(eq(aiConnectionRouterCursors.poolId, pool.id))).toEqual(beforeCursor);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, retry!.id)))[0]).toEqual(retry);
    expect(await releaseOrphanedRouterPin(db, input)).toMatchObject({ released: true, alreadyReleased: true });
    for (const mismatch of [
      { expectedMemberId: randomUUID() }, { poolId: randomUUID() }, { agentId: secondAgentId },
      { resetActivityId: randomUUID() }, { expectedRevision: input.expectedRevision + 1 },
    ]) await expect(releaseOrphanedRouterPin(db, { ...input, ...mismatch })).rejects.toThrow();
    const receipts = await db.select().from(activityLog).where(and(eq(activityLog.entityId, pin.id), eq(activityLog.action, "ai_connection.orphaned_task_pin_released")));
    expect(receipts).toHaveLength(1);
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, retry!.id));
  });

  it.each(["queued", "running", "bound_retry", "launch_evidence"])("retains the pin for %s execution", async (kind) => {
    const { task, pin, input } = await orphanedPinFixture();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId, status: ["queued", "running"].includes(kind) ? kind : "scheduled_retry",
      contextSnapshot: { issueId: task.id, ...(kind === "bound_retry" ? { aiRouterSelection: { poolId: input.poolId } } : {}) },
    }).returning();
    if (kind === "launch_evidence") await db.insert(heartbeatRunEvents).values({
      companyId, agentId, runId: run!.id, seq: 1, eventType: "adapter.invoke", stream: "system", level: "info", message: "Fixture launch",
    });
    await expect(releaseOrphanedRouterPin(db, input)).rejects.toThrow(/unclaimed retry|execution evidence/);
    expect(await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.id, pin.id))).toHaveLength(1);
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, run!.id));
  });

  it.each(["queued", "running", "terminal_process"])("retains affinity for a previous assignee's %s execution", async (kind) => {
    const { task, pin, input } = await orphanedPinFixture();
    await db.insert(heartbeatRuns).values({
      companyId, agentId: secondAgentId, status: kind === "terminal_process" ? "succeeded" : kind,
      contextSnapshot: { taskKey: task.id },
      ...(kind === "terminal_process" ? { processPid: process.pid } : {}),
    });
    await expect(releaseOrphanedRouterPin(db, input)).rejects.toThrow(/unclaimed retry|process ownership/);
    expect(await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.id, pin.id))).toHaveLength(1);
  });

  it.each(["taskKey", "taskId", "identifier", "wake_payload"])("finds active execution through %s binding", async (kind) => {
    const { task, pin, input } = await orphanedPinFixture();
    const [wake] = kind === "wake_payload" ? await db.insert(agentWakeupRequests).values({
      companyId, agentId, source: "automation", triggerDetail: "system", reason: "fixture", status: "claimed", payload: { taskId: task.id },
    }).returning() : [];
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId, status: "running", wakeupRequestId: wake?.id,
      contextSnapshot: kind === "wake_payload" ? {} : { [kind === "identifier" ? "taskKey" : kind]: kind === "identifier" ? task.identifier : task.id },
    }).returning();
    await expect(releaseOrphanedRouterPin(db, input)).rejects.toThrow("unclaimed retry");
    expect(await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.id, pin.id))).toHaveLength(1);
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, run!.id));
  });

  it.each(["live_pid", "unclosed_launch"])("rejects a terminal run with %s even without a recovery action", async (kind) => {
    const { task, pin, input } = await orphanedPinFixture();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId, status: "cancelled", contextSnapshot: { taskKey: task.id },
      ...(kind === "live_pid" ? { processPid: process.pid } : {}),
    }).returning();
    if (kind === "unclosed_launch") await db.insert(heartbeatRunEvents).values({
      companyId, agentId, runId: run!.id, seq: 1, eventType: "adapter.invoke", stream: "system", level: "info", message: "Fixture launch without stop",
    });
    await expect(releaseOrphanedRouterPin(db, input)).rejects.toThrow(/process ownership|verified termination/);
    expect(await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.id, pin.id))).toHaveLength(1);
  });

  it.skipIf(process.platform === "win32")("verifies physical absence for a local successful run without erasing its historical PID", async () => {
    const { task, input } = await orphanedPinFixture();
    const child = spawn(process.execPath, ["-e", ""], { detached: true, stdio: "ignore" });
    const pid = child.pid!;
    await once(child, "close");
    const leaseId = randomUUID();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId, status: "succeeded", exitCode: 0, processPid: pid, processGroupId: pid,
      finishedAt: new Date(), contextSnapshot: { taskKey: task.id, paperclipEnvironment: { driver: "local", provider: "local", leaseId } },
    }).returning();
    await db.insert(environmentLeases).values({ id: leaseId, companyId, heartbeatRunId: run!.id, provider: "local", status: "released", releasedAt: new Date() });
    await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId: run!.id, seq: 1, eventType: "adapter.invoke" });
    await expect(releaseOrphanedRouterPin(db, input)).rejects.toThrow("exact local host");
    await expect(releaseOrphanedRouterPin(db, { ...input, expectedLocalHost: "another-host" })).rejects.toThrow("exact local host");
    await expect(releaseOrphanedRouterPin(db, { ...input, expectedLocalHost: os.hostname() })).rejects.toThrow("original execution host");
    const localOriginVerifications = [{ runId: run!.id, leaseId, sourceHost: os.hostname(),
      evidence: "The test spawned this exact child on this host and awaited its close event; the fixture preserves its run and lease identity without a host migration." }];
    expect(await releaseOrphanedRouterPin(db, { ...input, expectedLocalHost: os.hostname(), localOriginVerifications })).toMatchObject({
      released: true, localTerminationProofs: [{ runId: run!.id, pid, processGroupId: pid, proof: "process_and_group_absent" }],
    });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id)))[0]).toEqual(run);
  });

  it("rejects a live or reused local PID despite a successful historical status", async () => {
    const { task, input } = await orphanedPinFixture();
    const leaseId = randomUUID();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId, status: "succeeded", exitCode: 0, processPid: process.pid, processGroupId: process.pid,
      processStartedAt: new Date(0), finishedAt: new Date(),
      contextSnapshot: { taskKey: task.id, paperclipEnvironment: { driver: "local", provider: "local", leaseId } },
    }).returning();
    await db.insert(environmentLeases).values({ id: leaseId, companyId, heartbeatRunId: run!.id, provider: "local", status: "released", releasedAt: new Date() });
    await expect(releaseOrphanedRouterPin(db, { ...input, expectedLocalHost: os.hostname(), localOriginVerifications: [{
      runId: run!.id, leaseId, sourceHost: os.hostname(),
      evidence: "This fixture deliberately uses the current test process PID with an old timestamp to represent a live or reused process on the verified local host.",
    }] })).rejects.toThrow("still live or its PID was reused");
  });

  it("does not refresh an old termination receipt through recovery bookkeeping", async () => {
    const { task, input } = await orphanedPinFixture();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "cancelled", contextSnapshot: { taskKey: task.id } }).returning();
    const launchAt = new Date(Date.now() - 1000);
    await db.insert(heartbeatRunEvents).values({
      companyId, agentId, runId: run!.id, seq: 1, eventType: "adapter.invoke", createdAt: launchAt,
    });
    const receipt = { runId: run!.id, providerStopped: true, actionOutcome: "not_performed", recordedAt: new Date(launchAt.getTime() - 60_000).toISOString() };
    const [action] = await db.insert(issueRecoveryActions).values({
      companyId, sourceIssueId: task.id, status: "resolved", ownerType: "board", kind: "active_run_watchdog",
      cause: "legacy_execution_requires_reconciliation", fingerprint: randomUUID(), nextAction: "Fixture settled",
      evidence: { runId: run!.id, executionReconciliation: receipt }, updatedAt: new Date(),
    }).returning();
    await expect(releaseOrphanedRouterPin(db, input)).rejects.toThrow("verified termination");
    await db.update(issueRecoveryActions).set({ evidence: {
      runId: run!.id, executionReconciliation: { ...receipt, recordedAt: new Date().toISOString() },
    } }).where(eq(issueRecoveryActions.id, action!.id));
    expect(await releaseOrphanedRouterPin(db, { ...input, dryRun: true })).toMatchObject({ eligible: true, released: false });
  });

  it("rejects stale identity, missing reset proof and retained task context", async () => {
    const { task, pin, input } = await orphanedPinFixture();
    await expect(releaseOrphanedRouterPin(db, { ...input, companyId: otherCompanyId })).rejects.toThrow("Task not found");
    await expect(releaseOrphanedRouterPin(db, { ...input, expectedMemberId: randomUUID() })).rejects.toThrow("allocation changed");
    await expect(releaseOrphanedRouterPin(db, { ...input, expectedRevision: input.expectedRevision + 1 })).rejects.toThrow("pool changed");
    await expect(releaseOrphanedRouterPin(db, { ...input, resetActivityId: randomUUID() })).rejects.toThrow("audited scoped session reset");
    await db.insert(agentTaskSessions).values({ companyId, agentId, adapterType: "paperclip_runner", taskKey: task.identifier!, sessionDisplayId: "retained-context" });
    await expect(releaseOrphanedRouterPin(db, input)).rejects.toThrow("Task context still exists");
    expect(await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.id, pin.id))).toHaveLength(1);
  });

  it("keeps orphaned-pin repair Board-only and defaults its route to preflight", async () => {
    const { pool, pin, input } = await orphanedPinFixture();
    const app = express(); app.use(express.json());
    let actor = { type: "board", userId: "alice", source: "session", companyIds: [companyId], memberships: [{ companyId, status: "active", membershipRole: "owner" }] };
    app.use((req, _res, next) => { req.actor = actor as typeof req.actor; next(); });
    app.use("/api", aiConnectionRoutes(db)); app.use(errorHandler);
    const body = {
      agentId: input.agentId, taskKey: input.taskKey, expectedPinId: input.expectedPinId,
      expectedMemberId: input.expectedMemberId, expectedRevision: input.expectedRevision, resetActivityId: input.resetActivityId,
    };
    const route = `/api/companies/${companyId}/ai-connection-pools/${pool.id}/task-pins/release`;
    const inspection = `/api/companies/${companyId}/ai-connection-pools/${pool.id}/task-pins/${agentId}/${input.taskKey}`;
    expect((await request(app).get(inspection)).body).toMatchObject({ expectedPinId: pin.id, expectedMemberId: pin.member.id });
    expect((await request(app).post(route).send(body)).body).toMatchObject({ released: false, eligible: true });
    actor = { ...actor, memberships: [{ companyId, status: "active", membershipRole: "viewer" }] };
    expect((await request(app).get(inspection)).status).toBe(403);
    expect((await request(app).post(route).send({ ...body, dryRun: false })).status).toBe(403);
    actor = { type: "agent", agentId, companyId, source: "agent_jwt" } as unknown as typeof actor;
    expect((await request(app).post(route).send({ ...body, dryRun: false })).status).toBe(403);
    expect(await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.id, pin.id))).toHaveLength(1);
  });
  it("rolls back both pin and cursor on a failure during commit", async () => {
    const pool = await makePool();
    await db.execute(`CREATE FUNCTION fixture_router_crash() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture commit crash'; END $$`);
    await db.execute(`CREATE TRIGGER fixture_router_crash BEFORE UPDATE ON ai_connection_router_cursors FOR EACH ROW EXECUTE FUNCTION fixture_router_crash()`);
    try { await expect(resolve(pool.id, "crash")).rejects.toThrow(); } finally { await db.execute(`DROP TRIGGER fixture_router_crash ON ai_connection_router_cursors`); await db.execute(`DROP FUNCTION fixture_router_crash()`); }
    expect(await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.poolId, pool.id))).toHaveLength(0);
    const selected = await resolve(pool.id, "crash"); expect(selected.memberId).toBe(members[0]!.id);
    const [cursor] = await db.select().from(aiConnectionRouterCursors).where(eq(aiConnectionRouterCursors.poolId, pool.id)); expect(cursor?.version).toBe(1);
  });
  it("rechecks config revisions after a proposal and preserves removed member snapshots", async () => {
    const pool = await makePool(); const old = await resolve(pool.id, "existing");
    const saved = await service().save(pluginKey, { companyId, id: pool.id, expectedRevision: pool.revision, config: { name: "Edited", enabled: true, mode: "round_robin", thresholdPercent: 90, members: [members[1]!] } }, "alice");
    await expect(service().save(pluginKey, { companyId, id: pool.id, expectedRevision: pool.revision, config: saved }, "alice")).rejects.toThrow();
    expect((await resolve(pool.id, "existing")).binding).toEqual(old.binding);
    expect((await resolve(pool.id, "future")).memberId).toBe(members[1]!.id);
  });
  it("keeps account and harness pinned through independent composer fallback", async () => {
    const pool = await makePool();
    const first = await resolve(pool.id, "composer");
    const changed = await resolve(pool.id, "composer", { overrides: { model: "claude-sonnet-5", modelReasoningEffort: "high" } });
    expect(changed.binding).toEqual(first.binding); expect(changed.runtimeConfig).toMatchObject({ provider: "codex", model: "gpt-5.6-sol", modelReasoningEffort: "high" }); expect(changed.notes).toHaveLength(1);
    const claude = poolMemberRuntimeConfig(members[1]!, "paperclip_runner", { model: "gpt-5.6-sol", modelReasoningEffort: "ultra" });
    expect(claude.config).toMatchObject({ provider: "acpx", acpxAgent: "claude", model: "claude-sonnet-5" }); expect(claude.notes).toHaveLength(2);
    const overrides = applyAiConnectionRouterTaskSettings({ model: "claude-sonnet-5", effort: "invalid", cwd: "/fixture" }, changed);
    const native = resolvePaperclipRunnerNativeProviderInput({ backend: "codex_app_server", adapterConfig: projectPaperclipRunnerTaskConfig("codex_app_server", changed.runtimeConfig, overrides) });
    expect(native).toMatchObject({ provider: "codex", model: "gpt-5.6-sol", codexReasoningEffort: "high" });
    expect(overrides).toMatchObject({ cwd: "/fixture" }); expect(overrides).not.toHaveProperty("effort");
  });
  it("retries a changed config proposal without advancing the abandoned selection", async () => {
    const pool = await makePool();
    proposal.mockImplementationOnce(async () => {
      await service().save(pluginKey, { companyId, id: pool.id, expectedRevision: pool.revision, config: { name: pool.name, enabled: true, mode: pool.mode, thresholdPercent: pool.thresholdPercent, members: [members[1]!] } }, "alice");
      return { kind: "selected", memberId: members[0]!.id };
    });
    expect((await resolve(pool.id, "revision-conflict")).memberId).toBe(members[1]!.id);
    const [cursor] = await db.select().from(aiConnectionRouterCursors).where(eq(aiConnectionRouterCursors.poolId, pool.id)); expect(cursor?.version).toBe(1);
  });
  it("fails closed when the experimental flag changes during a proposal", async () => {
    const pool = await makePool();
    proposal.mockImplementationOnce(async () => { await instanceSettingsService(db).updateExperimental({ enableAiConnectionRouters: false }); return { kind: "selected", memberId: members[0]!.id }; });
    try { await expect(resolve(pool.id, "disabled-in-flight")).rejects.toThrow("disabled during allocation"); expect(await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.poolId, pool.id))).toHaveLength(0); }
    finally { await instanceSettingsService(db).updateExperimental({ enableAiConnectionRouters: true }); }
  });
  it("uses only compatible legacy members and makes reassignment an independent pin", async () => {
    const pool = await makePool();
    expect((await resolve(pool.id, "legacy", { adapterType: "claude_local" })).memberId).toBe(members[1]!.id);
    expect((await resolve(pool.id, "legacy", { agentId: secondAgentId, adapterType: "codex_local" })).memberId).toBe(members[0]!.id);
    const pins = await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.poolId, pool.id)); expect(pins).toHaveLength(2);
  });
  it("adopts a valid existing account and requires explicit reset for an unrelated session", async () => {
    const pool = await makePool();
    expect((await resolve(pool.id, "adopt", { requireExisting: true, existingGrantId: members[1]!.binding.grantId })).memberId).toBe(members[1]!.id);
    await expect(resolve(pool.id, "foreign-session", { requireExisting: true, existingGrantId: randomUUID() })).rejects.toThrow("Reset");
    expect((await resolve(pool.id, "foreign-session")).memberId).toBe(members[0]!.id);
  });
  it("rejects cross-company access and unauthorized plugin proposals", async () => {
    const pool = await makePool();
    await expect(resolve(pool.id, "foreign", { companyId: otherCompanyId })).rejects.toThrow();
    proposal.mockResolvedValueOnce({ kind: "selected", memberId: randomUUID() });
    await expect(resolve(pool.id, "bad-proposal")).rejects.toThrow("unauthorized");
    expect(await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.poolId, pool.id))).toHaveLength(0);
  });
  it("does not grant members to another responsible user or move revoked pins", async () => {
    const pool = await makePool(); const selected = await resolve(pool.id, "revoke");
    await expect(resolve(pool.id, "revoke", { userId: "bob" })).rejects.toThrow();
    await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, selected.binding.mode === "responsible_user" ? "" : selected.binding.grantId));
    try { await expect(resolve(pool.id, "revoke")).rejects.toThrow(); expect((await resolve(pool.id, "new")).memberId).toBe(members[1]!.id); }
    finally { await db.update(connectionGrants).set({ status: "active" }).where(eq(connectionGrants.id, members[0]!.binding.grantId)); }
  });
  it("never probes pure rotation, caches authorized observations, and invalidates on credential change", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ five_hour: { utilization: 12 } })));
    try {
      const pure = await makePool(); await resolve(pure.id, "pure"); expect(spy).not.toHaveBeenCalled();
      const aware = await makePool({ mode: "usage_aware", members: [members[1]!] }); await resolve(aware.id, "aware"); expect(spy).toHaveBeenCalledTimes(1); await resolve(aware.id, "aware"); expect(spy).toHaveBeenCalledTimes(1);
      expect((await service().inspect(companyId, aware.id, "alice"))[members[1]!.id]?.checkedAt).not.toBeNull();
      const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, members[1]!.binding.grantId)); const ref = grant!.credentialSecretRefs.find(ref => ref.configPath === "ai.credential")!;
      await secretService(db).rotate(ref.secretId, { value: "fixture-refreshed", preserveAiSessionEpoch: true }, { userId: "alice" });
      expect((await service().inspect(companyId, aware.id, "alice"))[members[1]!.id]?.checkedAt).toBeNull();
      await resolve(aware.id, "aware"); expect(spy).toHaveBeenCalledTimes(2);
      proposal.mockResolvedValueOnce({ kind: "exhausted", retryAt: new Date(Date.now() + 60_000).toISOString(), skipped: {} });
      await expect(resolve(aware.id, "aware")).rejects.toBeInstanceOf(AiConnectionPoolExhausted);
      const pins = await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.poolId, aware.id)); expect(pins).toHaveLength(1);
    } finally { spy.mockRestore(); }
  });
  it("shares an in-flight usage observation across concurrent allocations", async () => {
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, members[1]!.binding.grantId));
    const ref = grant!.credentialSecretRefs.find(ref => ref.configPath === "ai.credential")!;
    await secretService(db).rotate(ref.secretId, { value: "fixture-shared-probe", preserveAiSessionEpoch: true }, { userId: "alice" });
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 100));
      return new Response(JSON.stringify({ five_hour: { utilization: 12 } }));
    });
    try {
      const pool = await makePool({ mode: "usage_aware", members: [members[1]!] });
      await Promise.all(Array.from({ length: 6 }, (_, index) => resolve(pool.id, `shared-probe-${index}`)));
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { fetch.mockRestore(); }
  });
  it("expires a usage observation at a reported reset", async () => {
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, members[1]!.binding.grantId));
    const ref = grant!.credentialSecretRefs.find(ref => ref.configPath === "ai.credential")!;
    await secretService(db).rotate(ref.secretId, { value: "fixture-reset-cache", preserveAiSessionEpoch: true }, { userId: "alice" });
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ five_hour: { utilization: 12, resets_at: new Date(Date.now() + 200).toISOString() } })));
    try {
      const pool = await makePool({ mode: "usage_aware", members: [members[1]!] }); await resolve(pool.id, "reset-cache"); expect(spy).toHaveBeenCalledTimes(1);
      await new Promise(resolve => setTimeout(resolve, 250)); await resolve(pool.id, "reset-cache"); expect(spy).toHaveBeenCalledTimes(2);
    } finally { spy.mockRestore(); }
  });
  it("treats unfinished probes as unknown within the shared selection budget", async () => {
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, members[1]!.binding.grantId));
    const ref = grant!.credentialSecretRefs.find(ref => ref.configPath === "ai.credential")!;
    await secretService(db).rotate(ref.secretId, { value: "fixture-slow-probe", preserveAiSessionEpoch: true }, { userId: "alice" });
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise<Response>(() => {}));
    try { const pool = await makePool({ mode: "usage_aware", members: [members[1]!] }); const start = Date.now(); expect((await resolve(pool.id, "slow-probe")).memberId).toBe(members[1]!.id); expect(Date.now() - start).toBeLessThan(20_000); expect(proposal.mock.calls.at(-1)?.[2].candidates[0]?.usage).toBeUndefined(); }
    finally { spy.mockRestore(); }
  }, 25_000);
  it("persists run-key affinity before policy calls and reuses it across allocation recovery", async () => {
    await instanceSettingsService(db).updateExperimental({ enableAiConnectionRouters: true, enableWorktreeRunExecution: true });
    const pool = await makePool({ members: [members[1]!] });
    const [agent] = await db.insert(agents).values({ companyId, name: "Run-key fixture", adapterType: "claude_local", adapterConfig: { cwd: home, engine: "cli" }, runtimeConfig: { aiConnection: { mode: "router", connectionId: pool.id }, heartbeat: { enabled: false } } }).returning();
    let affinity: string | undefined;
    const execute = vi.fn(); registerServerAdapter({ ...getServerAdapter("claude_local"), execute });
    const heartbeat = heartbeatService(db, { pluginWorkerManager: worker, runtimeEnv: {} });
    proposal.mockImplementationOnce(async (_id, _method, request) => {
      const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agent!.id), eq(heartbeatRuns.status, "running")));
      expect(run?.contextSnapshot?.aiRouterTaskKey).toBe(run?.id);
      expect(request.taskKey).toBe(run?.id);
      affinity = run!.id;
      throw new Error("fixture policy interruption");
    });
    try {
      const run = await heartbeat.wakeup(agent!.id, { source: "on_demand", reason: "manual", triggerDetail: "manual", contextSnapshot: { responsibleUserId: "alice", wakeReason: "manual" } });
      expect(run).not.toBeNull();
      await expect.poll(async () => (await heartbeat.getRun(run!.id))?.status, { timeout: 20_000 }).toBe("failed");
      expect(affinity).toBe(run!.id);
      expect((await heartbeat.getRun(run!.id))?.contextSnapshot?.aiRouterTaskKey).toBe(affinity);
      expect(execute).not.toHaveBeenCalled();
      const input = { agentId: agent!.id, adapterType: "claude_local" };
      const committed = await resolve(pool.id, affinity!, input);
      expect(await aiConnectionRouterService(db, worker).resolve({ companyId, poolId: pool.id, agentId: agent!.id, userId: "alice", adapterType: "claude_local", taskKey: affinity! })).toEqual(committed);
      const [cursor] = await db.select().from(aiConnectionRouterCursors).where(eq(aiConnectionRouterCursors.poolId, pool.id)); expect(cursor?.version).toBe(1);
      expect(await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.poolId, pool.id))).toHaveLength(1);
    } finally { proposal.mockReset(); proposal.mockImplementation(defaultProposal); unregisterServerAdapter("claude_local"); await heartbeat.drainActiveRunExecutions(); }
  }, 30_000);
  it("defers a pinned task before provider work and schedules a retry with its affinity intact", async () => {
    await instanceSettingsService(db).updateExperimental({ enableAiConnectionRouters: true, enableWorktreeRunExecution: true });
    const pool = await makePool({ members: [members[1]!] });
    const [agent] = await db.insert(agents).values({ companyId, name: "Quota fixture", adapterType: "claude_local", adapterConfig: { cwd: home, engine: "cli" }, runtimeConfig: { aiConnection: { mode: "router", connectionId: pool.id }, heartbeat: { enabled: false } } }).returning();
    const [issue] = await db.insert(issues).values({ companyId, title: "Quota fixture", status: "todo", assigneeAgentId: agent!.id, responsibleUserId: "alice", createdByUserId: "alice" }).returning();
    const pinned = await resolve(pool.id, issue!.id, { agentId: agent!.id, adapterType: "claude_local" });
    await service().save(pluginKey, { companyId, id: pool.id, expectedRevision: pool.revision, config: { name: pool.name, enabled: true, mode: "usage_aware", thresholdPercent: 90, members: [members[1]!] } }, "alice");
    const execute = vi.fn(); registerServerAdapter({ ...getServerAdapter("claude_local"), execute });
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ five_hour: { utilization: 100 } })));
    proposal.mockResolvedValueOnce({ kind: "exhausted", retryAt: new Date(Date.now() + 60_000).toISOString(), skipped: { [members[1]!.id]: "Exhausted" } });
    const heartbeat = heartbeatService(db, { pluginWorkerManager: worker, runtimeEnv: {} });
    try {
      const run = await heartbeat.wakeup(agent!.id, { source: "assignment", reason: "issue_assigned", payload: { issueId: issue!.id }, contextSnapshot: { issueId: issue!.id, wakeReason: "issue_assigned", responsibleUserId: "alice" }, triggerDetail: "system" });
      expect(run).not.toBeNull();
      await expect.poll(async () => (await heartbeat.getRun(run!.id))?.status, { timeout: 20_000 }).toBe("cancelled");
      const cancelled = await heartbeat.getRun(run!.id); expect(cancelled?.errorCode).toBe("ai_connection_pool_exhausted");
      expect(legacyExecutionNeedsReconciliation(cancelled!)).toBe(false);
      expect(legacyExecutionNeedsReconciliation({ ...cancelled!, resultJson: { executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: true } } })).toBe(true);
      await expect.poll(async () => (await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, agent!.id), eq(heartbeatRuns.scheduledRetryReason, "ai_connection_pool_wait")))).length, { timeout: 5000 }).toBe(1);
      const [retry] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, agent!.id), eq(heartbeatRuns.scheduledRetryReason, "ai_connection_pool_wait")));
      expect(retry?.contextSnapshot?.aiRouterTaskKey).toBe(issue!.id); expect(retry?.contextSnapshot?.executionRetryAccounting).toMatchObject({ failureRetries: 0 }); expect(execute).not.toHaveBeenCalled();
      const [pin] = await db.select().from(aiConnectionTaskPins).where(and(eq(aiConnectionTaskPins.poolId, pool.id), eq(aiConnectionTaskPins.agentId, agent!.id))); expect(pin?.selection).toEqual(pinned);
      const [cursor] = await db.select().from(aiConnectionRouterCursors).where(eq(aiConnectionRouterCursors.poolId, pool.id)); expect(cursor?.version).toBe(1);
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.agentId, agent!.id));
    } finally { fetch.mockRestore(); proposal.mockReset(); proposal.mockImplementation(defaultProposal); unregisterServerAdapter("claude_local"); await heartbeat.drainActiveRunExecutions(); }
  }, 30_000);
  it("repairs the failed pool account without replacing the pool or adopting the configured provider", async () => {
    const pool = await makePool({ members: [members[1]!] });
    const [agent] = await db.insert(agents).values({ companyId, name: "Pool repair", adapterType: "paperclip_runner", adapterConfig: { provider: "codex", model: "gpt-5.6-sol" }, runtimeConfig: { aiConnection: { mode: "router", connectionId: pool.id } } }).returning();
    const [issue] = await db.insert(issues).values({ companyId, title: "Pool repair", status: "in_progress", assigneeAgentId: agent!.id, responsibleUserId: "alice", createdByUserId: "alice" }).returning();
    const selection = await resolve(pool.id, issue!.id, { agentId: agent!.id });
    const runtime = await prepareManagedAiRuntime(db, { companyId, agentId: agent!.id, responsibleUserId: "alice", adapterType: "paperclip_runner", config: selection.runtimeConfig, binding: selection.binding });
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent!.id, status: "failed", errorCode: "acpx_auth_required", responsibleUserId: "alice", startedAt: new Date(), contextSnapshot: { issueId: issue!.id, aiRouterTaskKey: issue!.id, aiRouterSelection: selection, aiConnection: { ...runtime!.attribution, identity: runtime!.identity } } }).returning();
    try {
      const intents = connectionIntentService(db);
      const card = await intents.requestForRunAuthFailure(run!.id);
      expect(card?.service).toBe("anthropic"); expect(card?.state).toBe("needs_user_action");
      const options = await intents.setupOptions(card!.interactionId!);
      expect(options.aiConnection).toEqual(selection.binding); expect(options.aiConnectionRequiresAdoption).toBeUndefined();
      const [failedGrant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, members[1]!.binding.grantId)); expect(failedGrant?.status).toBe("needs_reauthorization");
      await db.update(connectionGrants).set({ status: "active" }).where(eq(connectionGrants.id, members[1]!.binding.grantId));
      await db.update(toolConnections).set({ healthStatus: "ok" }).where(eq(toolConnections.id, members[1]!.binding.connectionId));
      expect(await intents.complete(card!.interactionId!, members[1]!.binding.connectionId, "alice")).toMatchObject({ status: "accepted" });
      const [savedAgent] = await db.select().from(agents).where(eq(agents.id, agent!.id)); expect(savedAgent?.runtimeConfig.aiConnection).toEqual({ mode: "router", connectionId: pool.id });
      expect((await resolve(pool.id, issue!.id, { agentId: agent!.id })).binding).toEqual(selection.binding);
      await db.update(agents).set({ runtimeConfig: { aiConnection: { mode: "router", connectionId: randomUUID() } } }).where(eq(agents.id, agent!.id));
      await expect(intents.setupOptions(card!.interactionId!)).rejects.toThrow("configuration changed");
    } finally {
      await runtime?.cleanup();
      await db.update(connectionGrants).set({ status: "active" }).where(eq(connectionGrants.id, members[1]!.binding.grantId));
      await db.update(toolConnections).set({ healthStatus: "ok" }).where(eq(toolConnections.id, members[1]!.binding.connectionId));
    }
  });
  it("rejects disabled routing but recovers server-owned native evidence after disable/uninstall", async () => {
    const pool = await makePool(); const selected = await resolve(pool.id, "recovery");
    await instanceSettingsService(db).updateExperimental({ enableAiConnectionRouters: false });
    try { await expect(resolve(pool.id, "recovery")).rejects.toMatchObject({ status: 422, details: { code: "ai_connection_router_disabled" } }); expect(await resolve(pool.id, "recovery", { persisted: selected })).toEqual(selected); }
    finally { await instanceSettingsService(db).updateExperimental({ enableAiConnectionRouters: true }); }
    await db.update(plugins).set({ status: "disabled" }).where(eq(plugins.id, pluginId));
    try { await expect(resolve(pool.id, "new")).rejects.toThrow("plugin"); expect(await resolve(pool.id, "recovery", { persisted: selected })).toEqual(selected); await db.delete(toolConnections).where(eq(toolConnections.id, pool.id)); expect(await resolve(pool.id, "recovery", { persisted: selected })).toEqual(selected); }
    finally { await db.update(plugins).set({ status: "ready" }).where(eq(plugins.id, pluginId)); }
  });
  it("resumes a responsible-user session through a delegated pool using real managed account configurations", async () => {
    await aiConnectionService(db).setDefault(companyId, "alice", members[0]!.binding.grantId!);
    const pool = await makePool({ members: [members[0]!] });
    const selected = await resolve(pool.id, "managed-mode-adoption", { requireExisting: true, existingGrantId: members[0]!.binding.grantId });
    const directBinding = { mode: "responsible_user" as const, provider: "openai" as const, method: "api_key" as const };
    const prepare = { companyId, agentId, responsibleUserId: "alice", adapterType: "paperclip_runner", config: selected.runtimeConfig };
    const before = await prepareManagedAiRuntime(db, { ...prepare, binding: directBinding });
    const after = await prepareManagedAiRuntime(db, { ...prepare, binding: selected.binding });
    try {
      expect(before.config.managedAiConnection.mode).toBe("responsible_user");
      expect(after.config.managedAiConnection.mode).toBe("delegated");
      expect(after.sessionIdentity).toBe(before.sessionIdentity);
      const common = { adapterType: "paperclip_runner", issueOverrides: null, workspaceConfig: {}, environment: {}, environmentEnv: null, projectEnv: null, routineEnv: null, runtimeSkills: [], agentConfigRevision: null };
      const previous = await buildEffectiveRunSessionConfigMetadata({ ...common, effectiveAdapterConfig: before.config, managedAiHome: before.home, agentRuntimeConfig: { aiConnection: directBinding } });
      const currentInput = { ...common, effectiveAdapterConfig: after.config, managedAiHome: after.home, agentRuntimeConfig: { aiConnection: { mode: "router", connectionId: pool.id } } };
      const current = await buildEffectiveRunSessionConfigMetadata(currentInput);
      const alternatives = aiConnectionSessionCompatibilityInputs({ ...currentInput, originalIssueOverrides: null, binding: selected.binding, router: true, storedIdentity: before.sessionIdentity, sessionIdentity: after.sessionIdentity, credentialIdentity: after.identity, revisions: [] });
      const compatibleConfigMetadata = await Promise.all(alternatives.map(candidate => buildEffectiveRunSessionConfigMetadata({ ...currentInput, ...candidate })));
      expect(resolveTaskSessionConfigFreshness({ hasTaskSession: true, configuredModel: String(selected.runtimeConfig.model), taskSessionParams: { __paperclipConfiguredModel: selected.runtimeConfig.model, __paperclipConfigFingerprint: previous.fingerprint, __paperclipConfigFingerprintVersion: previous.version, __paperclipConfigCategoryFingerprints: previous.categoryFingerprints }, configMetadata: current, compatibleConfigMetadata }).reset).toBe(false);
    } finally { await before.cleanup(); await after.cleanup(); }
  });
  it("keeps session identity and fingerprints stable on authenticated refresh, but changes them on manual replacement", async () => {
    const input = { companyId, agentId, responsibleUserId: "alice", adapterType: "paperclip_runner", binding: members[0]!.binding, config: { provider: "codex", model: "gpt-5.6-sol" } };
    const first = await prepareManagedAiRuntime(db, input);
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, members[0]!.binding.grantId)); const ref = grant!.credentialSecretRefs.find(ref => ref.configPath === "ai.credential")!;
    try {
      await secretService(db).rotate(ref.secretId, { value: "fixture-new-token", preserveAiSessionEpoch: true }, { userId: "alice" });
      const refreshed = await prepareManagedAiRuntime(db, input);
      try { expect(refreshed.identity).not.toBe(first.identity); expect(refreshed.sessionIdentity).toBe(first.sessionIdentity); expect(managedAiSessionFingerprintConfig(refreshed.config, refreshed.home)).toEqual(managedAiSessionFingerprintConfig(first.config, first.home)); } finally { await refreshed.cleanup(); }
      await secretService(db).rotate(ref.secretId, { value: "fixture-replacement" }, { userId: "alice" });
      const replaced = await prepareManagedAiRuntime(db, input); try { expect(replaced.sessionIdentity).not.toBe(first.sessionIdentity); } finally { await replaced.cleanup(); }
      const [secret] = await db.select().from(companySecrets).where(and(eq(companySecrets.companyId, companyId), eq(companySecrets.id, ref.secretId))); expect(secret!.aiSessionEpoch).toBeGreaterThan(0);
    } finally { await first.cleanup(); }
  });
});
