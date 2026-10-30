import { and, eq, inArray } from "drizzle-orm";
import { issueThreadInteractions, type Db } from "@paperclipai/db";
import { issueThreadInteractionAttentionAgentAllowed } from "./issue-thread-interaction-resolution.js";

/** Dependency-blocked tasks may receive only their verified addressed question. */
export async function hasPendingQuestionAddresseeWake(db: Db, input: {
  companyId: string;
  issueId: string;
  agentId: string;
  contextSnapshot: Record<string, unknown>;
}) {
  const context = input.contextSnapshot;
  if (context.wakeReason !== "interaction_pending" || context.source !== "issue.interaction.created") return false;
  const interactionId = typeof context.interactionId === "string" ? context.interactionId : null;
  if (!interactionId || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(interactionId)) return false;
  const [interaction] = await db.select().from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.id, interactionId),
    eq(issueThreadInteractions.companyId, input.companyId),
    eq(issueThreadInteractions.issueId, input.issueId),
    eq(issueThreadInteractions.kind, "ask_user_questions"),
    eq(issueThreadInteractions.status, "pending"),
    eq(issueThreadInteractions.addresseeAgentId, input.agentId),
  )).limit(1).for("update");
  return Boolean(interaction && issueThreadInteractionAttentionAgentAllowed({ agentId: input.agentId, interaction }));
}

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
