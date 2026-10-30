import { and, eq, or, sql, type SQL } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns } from "@paperclipai/db";

const uuidPattern = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
const taskUuid = new RegExp(uuidPattern, "i");
export function isTaskUuid(value: unknown): value is string {
  return typeof value === "string" && taskUuid.test(value.trim());
}
const uuidAlias = (value: SQL) => sql`case when btrim(${value}) ~* ${uuidPattern} then lower(btrim(${value})) end`;

// Session keys can also be named taskId; only UUID aliases bind an issue.
export const canonicalRunTaskId = sql<string | null>`coalesce(
  ${heartbeatRuns.nativeIssueId}::text,
  ${uuidAlias(sql`${heartbeatRuns.contextSnapshot}->>'issueId'`)},
  ${uuidAlias(sql`${heartbeatRuns.contextSnapshot}->>'taskId'`)},
  (select coalesce(${uuidAlias(sql`w.payload->>'issueId'`)}, ${uuidAlias(sql`w.payload->>'taskId'`)},
    ${uuidAlias(sql`w.payload->'_paperclipWakeContext'->>'issueId'`)},
    ${uuidAlias(sql`w.payload->'_paperclipWakeContext'->>'taskId'`)})
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
