import { and, eq, or, sql } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns } from "@paperclipai/db";

// A native binding wins over compatibility aliases and wake payloads.
export const canonicalRunTaskId = sql<string | null>`coalesce(
  ${heartbeatRuns.nativeIssueId}::text,
  nullif(${heartbeatRuns.contextSnapshot}->>'issueId', ''),
  nullif(${heartbeatRuns.contextSnapshot}->>'taskId', ''),
  (select coalesce(w.payload->>'issueId', w.payload->>'taskId',
    w.payload->'_paperclipWakeContext'->>'issueId', w.payload->'_paperclipWakeContext'->>'taskId')
   from ${agentWakeupRequests} w where w.id = ${heartbeatRuns.wakeupRequestId}
     and w.company_id = ${heartbeatRuns.companyId})
)`;

export function taskRunBinding(input: {
  companyId: string; issueId: string; executionRunId?: string | null;
}) {
  return and(eq(heartbeatRuns.companyId, input.companyId), or(
    sql`${canonicalRunTaskId} = ${input.issueId}`,
    input.executionRunId
      ? and(eq(heartbeatRuns.id, input.executionRunId), sql`${canonicalRunTaskId} is null`)
      : undefined,
  ));
}
