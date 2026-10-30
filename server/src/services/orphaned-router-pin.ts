import { and, desc, eq, inArray, isNotNull, notInArray, or, sql } from "drizzle-orm";
import { hostname } from "node:os";
import {
  activityLog, agentTaskSessions, agentWakeupRequests, aiConnectionPools, aiConnectionRouterCursors,
  aiConnectionTaskPins, environmentLeases, heartbeatRunEvents, heartbeatRuns,
  issues, issueRecoveryActions, nativeRunFinalizations, type Db,
} from "@paperclipai/db";
import { conflict, notFound } from "../errors.js";
import { logActivity } from "./activity-log.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import { hasNativeLocalProcessStop, PROCESS_IDENTITY_RECORDED, PROCESS_START_REQUESTED } from "./native-local-process-stop.js";

const RELEASE_ACTION = "ai_connection.orphaned_task_pin_released";

export async function inspectRouterTaskPin(db: Db, input: { companyId: string; poolId: string; agentId: string; taskKey: string }) {
  const [row] = await db.select({
    expectedPinId: aiConnectionTaskPins.id, expectedMemberId: sql<string>`${aiConnectionTaskPins.member}->>'id'`,
    expectedRevision: aiConnectionPools.revision, allocatedAt: aiConnectionTaskPins.createdAt,
  }).from(aiConnectionTaskPins).innerJoin(aiConnectionPools, and(
    eq(aiConnectionPools.companyId, aiConnectionTaskPins.companyId), eq(aiConnectionPools.id, aiConnectionTaskPins.poolId),
  )).where(and(
    eq(aiConnectionTaskPins.companyId, input.companyId), eq(aiConnectionTaskPins.poolId, input.poolId),
    eq(aiConnectionTaskPins.agentId, input.agentId), eq(aiConnectionTaskPins.taskKey, input.taskKey),
  )).limit(1);
  if (!row) throw notFound("Task allocation not found");
  return { ...input, ...row, localHost: hostname() };
}

/** Board-only repair after a separate, audited context reset. Never selects an
 * account, resets context, changes capacity, cancels work, or dispatches a retry. */
export async function releaseOrphanedRouterPin(db: Db, input: {
  companyId: string; poolId: string; agentId: string; taskKey: string;
  expectedPinId: string; expectedMemberId: string; expectedRevision: number;
  resetActivityId: string; actorId: string; dryRun: boolean;
  expectedLocalHost?: string;
  localOriginVerifications?: Array<{ runId: string; leaseId: string; sourceHost: string; evidence: string }>;
}) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('statement_timeout', '15000', true), set_config('lock_timeout', '1000', true)`);
    const [task] = await tx.select().from(issues).where(and(
      eq(issues.companyId, input.companyId), eq(issues.id, input.taskKey),
    )).for("update");
    if (!task) throw notFound("Task not found");
    const [previous] = await tx.select({ id: activityLog.id, details: activityLog.details }).from(activityLog).where(and(
      eq(activityLog.companyId, input.companyId), eq(activityLog.action, RELEASE_ACTION),
      eq(activityLog.entityType, "ai_connection_task_pin"), eq(activityLog.entityId, input.expectedPinId),
      sql`${activityLog.details}->>'taskKey' = ${input.taskKey}`,
      sql`${activityLog.details}->>'poolId' = ${input.poolId}`,
      sql`${activityLog.details}->>'agentId' = ${input.agentId}`,
      sql`${activityLog.details}->>'previousMemberId' = ${input.expectedMemberId}`,
      sql`${activityLog.details}->>'resetActivityId' = ${input.resetActivityId}`,
      sql`${activityLog.details}->>'poolRevision' = ${String(input.expectedRevision)}`,
    )).limit(1);
    if (previous) return { ...previous.details, released: true, alreadyReleased: true, activityId: previous.id };
    if (task.assigneeAgentId !== input.agentId) throw conflict("The task owner changed; inspect it again");
    // Match allocation's cursor -> pool order. Task admission serializes on the
    // task row, while the cursor prevents a concurrent replacement allocation.
    await tx.select().from(aiConnectionRouterCursors).where(and(
      eq(aiConnectionRouterCursors.companyId, input.companyId), eq(aiConnectionRouterCursors.poolId, input.poolId),
    )).for("update");
    const [pool] = await tx.select().from(aiConnectionPools).where(and(
      eq(aiConnectionPools.companyId, input.companyId), eq(aiConnectionPools.id, input.poolId),
    )).for("share");
    if (!pool || pool.revision !== input.expectedRevision) throw conflict("The pool changed; inspect it again");
    const [pin] = await tx.select().from(aiConnectionTaskPins).where(and(
      eq(aiConnectionTaskPins.id, input.expectedPinId), eq(aiConnectionTaskPins.companyId, input.companyId),
      eq(aiConnectionTaskPins.poolId, input.poolId), eq(aiConnectionTaskPins.agentId, input.agentId),
      eq(aiConnectionTaskPins.taskKey, task.id),
    )).for("update");
    if (!pin || pin.member.id !== input.expectedMemberId || pin.selection.memberId !== input.expectedMemberId
      || pin.selection.poolId !== pool.id) throw conflict("The task allocation changed; inspect it again");
    const [reset] = await tx.select().from(activityLog).where(and(
      eq(activityLog.id, input.resetActivityId), eq(activityLog.companyId, input.companyId),
      eq(activityLog.actorType, "user"), eq(activityLog.entityType, "agent"),
      eq(activityLog.entityId, input.agentId), eq(activityLog.action, "agent.runtime_session_reset"),
    )).limit(1);
    const aliases = [task.id, ...(task.identifier ? [task.identifier] : [])];
    if (!reset || !aliases.includes(String(reset.details?.taskKey)) || reset.createdAt <= pin.createdAt) {
      throw conflict("An audited scoped session reset after this allocation is required");
    }
    const [session] = await tx.select({ id: agentTaskSessions.id }).from(agentTaskSessions).where(and(
      eq(agentTaskSessions.companyId, input.companyId), eq(agentTaskSessions.agentId, input.agentId),
      inArray(agentTaskSessions.taskKey, aliases),
    )).limit(1);
    if (session) throw conflict("Task context still exists; its allocation must remain pinned");
    if (await getExecutionBlocker(tx as unknown as Db, input.companyId, task.id)) {
      throw conflict("Reconcile the task's execution hold before releasing its allocation");
    }
    const [coordinator] = await tx.select({ id: nativeRunFinalizations.runId }).from(nativeRunFinalizations).where(and(
      eq(nativeRunFinalizations.companyId, input.companyId), eq(nativeRunFinalizations.issueId, task.id),
      or(notInArray(nativeRunFinalizations.phase, ["applied", "terminal_failure"]), isNotNull(nativeRunFinalizations.leaseOwner)),
    )).limit(1);
    if (coordinator) throw conflict("Native execution or recovery has not settled");
    const bound = await tx.select().from(heartbeatRuns).where(and(
      // A previous assignee can still own execution for this task. Repair must
      // settle that execution too, rather than inspect only today's assignee.
      eq(heartbeatRuns.companyId, input.companyId),
      or(inArray(sql`${heartbeatRuns.nativeIssueId}::text`, aliases),
        ...["issueId", "taskKey", "taskId", "aiRouterTaskKey"].map(key => inArray(sql`${heartbeatRuns.contextSnapshot}->>${key}`, aliases)),
        sql`exists (select 1 from ${agentWakeupRequests} wake where wake.company_id = ${input.companyId}::uuid
          and wake.id = ${heartbeatRuns.wakeupRequestId} and (
            ${or(...["issueId", "taskKey", "taskId"].map(key => inArray(sql`wake.payload->>${key}`, aliases)))}
          ))`),
    )).for("update");
    const leases = await tx.select().from(environmentLeases).where(and(
      eq(environmentLeases.companyId, input.companyId),
      or(eq(environmentLeases.issueId, task.id), inArray(environmentLeases.heartbeatRunId, bound.map(run => run.id))),
    ));
    if (leases.some(lease => lease.provider === "local"
      ? !lease.releasedAt || lease.status === "pending_cleanup" || lease.cleanupStatus === "failed"
      : !hasRemoteTerminationReceipt(lease))) throw conflict("Task execution cleanup has not settled");
    const pending = bound.filter(run => ["queued", "running", "scheduled_retry"].includes(run.status));
    if (pending.some(run => run.status !== "scheduled_retry" || run.runtimeMode !== "legacy"
      || run.startedAt || run.runtimeModeResolvedAt || run.processPid || run.processGroupId || run.processStartedAt
      || run.nativeIssueId || run.nativeSessionId || run.sessionIdBefore || run.sessionIdAfter || run.executionStage
      || run.controllerBootId || run.controllerLeaseExpiresAt || run.runnerProfileJson || run.resultJson
      || run.contextSnapshot?.aiRouterSelection != null || run.contextSnapshot?.aiConnection != null)) {
      throw conflict("Only an unclaimed retry without persisted provider context may remain");
    }
    const localTerminationProofs: Array<Record<string, unknown>> = [];
    if (bound.length) {
      const evidence = await tx.selectDistinctOn([heartbeatRunEvents.runId], {
        runId: heartbeatRunEvents.runId, createdAt: heartbeatRunEvents.createdAt,
      }).from(heartbeatRunEvents).where(and(
        eq(heartbeatRunEvents.companyId, input.companyId), inArray(heartbeatRunEvents.runId, bound.map(run => run.id)),
        or(isNotNull(heartbeatRunEvents.sourceEventId), inArray(heartbeatRunEvents.eventType, [
          "adapter.invoke", PROCESS_START_REQUESTED, PROCESS_IDENTITY_RECORDED, "harness.ready", "session.started",
          "session.resumed", "session.updated", "turn.started", "provider.event", "provider.rpc_result", "tool.execution.started",
        ])),
      )).orderBy(heartbeatRunEvents.runId, desc(heartbeatRunEvents.seq));
      for (const run of bound) {
        // Terminal status does not prove provider termination. Refuse retained
        // process identities or live controller claims even without a hold row.
        if (run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > new Date()) {
          throw conflict("Provider process ownership has not been settled");
        }
        const runLeases = leases.filter(lease => lease.heartbeatRunId === run.id);
        if (run.processPid || run.processGroupId) {
          const environment = run.contextSnapshot?.paperclipEnvironment as Record<string, unknown> | undefined;
          const localLease = runLeases.find(lease => lease.id === environment?.leaseId);
          // Historical leases do not contain a machine fingerprint. The
          // privileged operator must independently establish the original host;
          // echoing today's hostname alone is not evidence of that history.
          const origin = input.localOriginVerifications?.find(item => item.runId === run.id
            && item.leaseId === localLease?.id && item.sourceHost === hostname() && item.evidence.trim().length >= 80);
          if (input.expectedLocalHost !== hostname() || environment?.provider !== "local" || environment?.driver !== "local"
            || !localLease || runLeases.some(lease => lease.provider !== "local")
            || !run.processPid || run.processPid <= 1 || !run.processGroupId || run.processGroupId <= 1) {
            throw conflict("Provider process ownership requires an exact local host and lease receipt");
          }
          if (!origin) throw conflict("Document independent verification of the original execution host before repairing this pin");
          // Signal zero only. A live or reused PID, EPERM, or an unknown error
          // retains affinity. Never signal remote IDs or clear historical PIDs.
          for (const pid of [run.processPid, -run.processGroupId]) {
            try { process.kill(pid, 0); }
            catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ESRCH") continue;
              throw conflict("Provider process ownership cannot be verified");
            }
            throw conflict("Provider process ownership is still live or its PID was reused");
          }
          localTerminationProofs.push({ runId: run.id, leaseId: localLease.id, pid: run.processPid,
            processGroupId: run.processGroupId, host: hostname(), observedAt: new Date().toISOString(), proof: "process_and_group_absent",
            originVerification: { kind: "operator_verified_same_host", actorId: input.actorId, evidence: origin.evidence } });
          continue;
        }
        const execution = evidence.find(row => row.runId === run.id);
        if (!execution) continue;
        if (pending.some(row => row.id === run.id)) throw conflict("Retained provider execution evidence prevents allocation release");
        if ((runLeases.length > 0 && runLeases.every(lease => lease.provider !== "local" && hasRemoteTerminationReceipt(lease)))
          || (run.runtimeMode === "native" && await hasNativeLocalProcessStop(tx as unknown as Db, input.companyId, run.id))) continue;
        const reconciled = await tx.select({ evidence: issueRecoveryActions.evidence }).from(issueRecoveryActions).where(and(
          eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.sourceIssueId, task.id),
          eq(issueRecoveryActions.status, "resolved"),
          sql`${issueRecoveryActions.evidence}->'executionReconciliation'->>'runId' = ${run.id}`,
          sql`${issueRecoveryActions.evidence}->'executionReconciliation'->>'providerStopped' = 'true'`,
        ));
        const freshReceipt = reconciled.some(row => {
          const receipt = row.evidence.executionReconciliation as Record<string, unknown> | undefined;
          const at = typeof receipt?.recordedAt === "string" ? Date.parse(receipt.recordedAt) : NaN;
          return Number.isFinite(at) && at >= execution.createdAt.getTime();
        });
        if (!freshReceipt) throw conflict("Retained provider execution evidence requires verified termination");
      }
    }
    const receipt = {
      pinId: pin.id, taskKey: task.id, poolId: pool.id, agentId: input.agentId,
      resetActivityId: reset.id, poolRevision: pool.revision, scheduledRetryIdsPreserved: pending.map(run => run.id),
      dispatch: "not_requested", contextReset: "not_requested", localTerminationProofs,
    };
    if (input.dryRun) return { released: false, eligible: true, ...receipt };
    await tx.delete(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.id, pin.id));
    await logActivity(tx as unknown as Db, {
      companyId: input.companyId, actorType: "user", actorId: input.actorId,
      action: RELEASE_ACTION, entityType: "ai_connection_task_pin", entityId: pin.id,
      details: { ...receipt, previousMemberId: pin.member.id },
    });
    return { released: true, ...receipt };
  });
}
