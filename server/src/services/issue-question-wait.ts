import { and, eq, inArray } from "drizzle-orm";
import { issueThreadInteractions, type Db } from "@paperclipai/db";

/** A response can commit before its creator parks; keep that continuation with
 * its implementer too. An old run's card cannot defer a new review handoff. */
export async function hasAssigneeQuestionWait(db: Db, input: {
  companyId: string;
  issueId: string;
  assigneeAgentId?: string | null;
  agentId?: string | null;
  runId?: string | null;
  requestedStatus?: string;
}) {
  if (!input.agentId || !input.runId || input.assigneeAgentId !== input.agentId ||
      input.requestedStatus !== "in_review") return false;
  const [question] = await db.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.companyId, input.companyId),
    eq(issueThreadInteractions.issueId, input.issueId),
    eq(issueThreadInteractions.kind, "ask_user_questions"),
    inArray(issueThreadInteractions.status, ["pending", "answered"]),
    eq(issueThreadInteractions.continuationPolicy, "wake_assignee"),
    eq(issueThreadInteractions.createdByAgentId, input.agentId),
    eq(issueThreadInteractions.sourceRunId, input.runId),
  )).limit(1);
  return Boolean(question);
}
