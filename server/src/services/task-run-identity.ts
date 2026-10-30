import { and, eq, or, sql, type SQL } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns } from "@paperclipai/db";

const uuidPattern = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
const taskUuid = new RegExp(uuidPattern, "i");
export function normalizeTaskUuid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return taskUuid.test(normalized) ? normalized : null;
}
// Match the ECMAScript TrimString set used above, including tabs and line ends.
const trimCharacters = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
const uuidAlias = (value: SQL) => sql`case when btrim(${value}, ${trimCharacters}) ~* ${uuidPattern}
  then lower(btrim(${value}, ${trimCharacters})) end`;

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
  companyId: string; issueId: string; executionRunId?: string | null; checkoutRunId?: string | null;
}) {
  return and(eq(heartbeatRuns.companyId, input.companyId), or(
    sql`${canonicalRunTaskId} = ${input.issueId}`,
    input.executionRunId || input.checkoutRunId
      ? and(or(input.executionRunId ? eq(heartbeatRuns.id, input.executionRunId) : undefined,
          input.checkoutRunId ? eq(heartbeatRuns.id, input.checkoutRunId) : undefined),
        sql`${canonicalRunTaskId} is null`)
      : undefined,
  ));
}
