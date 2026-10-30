import { randomUUID } from "node:crypto";
import type { AskUserQuestionsPayload } from "@paperclipai/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues, issueThreadInteractions } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { hasAssigneeQuestionWait } from "./issue-question-wait.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

interface QuestionWaitCase {
  name: string; expected: boolean; status?: string; kind?: string; continuationPolicy?: string;
  otherCompany?: true; noQuestion?: true; otherCreator?: true; otherRun?: true; otherIssue?: true;
  board?: true; nonAssignee?: true; done?: true; missingRun?: true;
}

describePostgres("assignee question wait evidence", () => {
  let db: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("question-wait-"); db = createDb(temp.connectionString); }, 20_000);
  afterEach(async () => {
    await db.delete(issues); await db.delete(heartbeatRuns); await db.delete(agents); await db.delete(companies);
  });
  afterAll(async () => { await temp?.cleanup(); });

  it.each([
    { name: "pending source question", expected: true },
    { name: "another company", expected: false, otherCompany: true },
    { name: "no question", expected: false, noQuestion: true },
    { name: "response committed before parking", expected: true, status: "answered" },
    { name: "expired question", expected: false, status: "expired" },
    { name: "another creator", expected: false, otherCreator: true },
    { name: "another source run", expected: false, otherRun: true },
    { name: "another issue", expected: false, otherIssue: true },
    { name: "confirmation", expected: false, kind: "request_confirmation" },
    { name: "no continuation", expected: false, continuationPolicy: "none" },
    { name: "Board trace without agent authentication", expected: false, board: true },
    { name: "non-assignee", expected: false, nonAssignee: true },
    { name: "Done request", expected: false, done: true },
    { name: "missing source run", expected: false, missingRun: true },
  ] as const)("$name", async (testCase: QuestionWaitCase) => {
    const companyId = randomUUID(), agentId = randomUUID(), otherId = randomUUID();
    const issueId = randomUUID(), otherIssueId = randomUUID(), runId = randomUUID(), otherRunId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Question fixture", issuePrefix: `Q${companyId.slice(0, 6)}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([agentId, otherId].map((id) => ({ id, companyId, name: id, role: "engineer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} })));
    await db.insert(issues).values([issueId, otherIssueId].map((id) => ({ id, companyId, title: "Question wait", status: "in_progress", priority: "medium", assigneeAgentId: agentId })));
    await db.insert(heartbeatRuns).values([runId, otherRunId].map((id) => ({ id, companyId, agentId, status: "running" })));
    const payload: AskUserQuestionsPayload = { version: 1, questions: [{ id: "scope", prompt: "Which scope?", selectionMode: "single", options: [{ id: "continue", label: "Continue" }] }] };
    if (!("noQuestion" in testCase)) await db.insert(issueThreadInteractions).values({ companyId, issueId: "otherIssue" in testCase ? otherIssueId : issueId,
      kind: testCase.kind ?? "ask_user_questions", status: testCase.status ?? "pending",
      continuationPolicy: testCase.continuationPolicy ?? "wake_assignee",
      createdByAgentId: "otherCreator" in testCase ? otherId : agentId, sourceRunId: "otherRun" in testCase ? otherRunId : runId,
      payload,
    });
    expect(await hasAssigneeQuestionWait(db, { companyId: "otherCompany" in testCase ? randomUUID() : companyId, issueId,
      assigneeAgentId: "nonAssignee" in testCase ? otherId : agentId,
      agentId: "board" in testCase ? null : agentId, runId: "missingRun" in testCase ? null : runId,
      requestedStatus: "done" in testCase ? "done" : "in_review",
    })).toBe(testCase.expected);
  });
});
