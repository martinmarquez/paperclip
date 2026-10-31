import { z } from "zod";
import { badRequest } from "../errors.js";

const inputSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("get_task") }),
  z.strictObject({ operation: z.literal("get_comments") }),
  z.strictObject({ operation: z.literal("get_document"), key: z.string().regex(/^[a-z0-9_-]{1,80}$/) }),
  z.strictObject({ operation: z.literal("save_document"), key: z.string().regex(/^[a-z0-9_-]{1,80}$/),
    title: z.string().min(1).max(200), body: z.string().max(64 * 1024), baseRevisionId: z.uuid().nullable() }),
  z.strictObject({ operation: z.literal("checkout") }),
  z.strictObject({ operation: z.literal("set_status"), status: z.enum(["blocked", "in_review", "done"]),
    comment: z.string().min(1).max(16 * 1024) }),
]);

export const reviewTaskTool = { name: "paperclip_review_task",
  description: "Read the authenticated run's own task, checkout, save a review document with revision control, or set its review outcome. No other task, assignment, project or resource can be changed.",
  inputSchema: z.toJSONSchema(inputSchema) };

export function reviewTaskRequest(raw: unknown, issueId: string, agentId: string) {
  const args = inputSchema.parse(raw);
  const root = `/issues/${encodeURIComponent(issueId)}`;
  switch (args.operation) {
    case "get_task": return { path: root, method: "GET" };
    case "get_comments": return { path: `${root}/comments?order=asc&limit=50`, method: "GET" };
    case "get_document": return { path: `${root}/documents/${args.key}`, method: "GET" };
    case "save_document": return { path: `${root}/documents/${args.key}`, method: "PUT",
      body: { title: args.title, format: "markdown", body: args.body, baseRevisionId: args.baseRevisionId } };
    case "checkout": return { path: `${root}/checkout`, method: "POST",
      body: { agentId, expectedStatuses: ["todo", "in_progress", "in_review", "blocked"] } };
    case "set_status": return { path: root, method: "PATCH", body: { status: args.status, comment: args.comment } };
  }
}

export async function callReviewTaskTool(input: {
  arguments: unknown; issueId: string; agentId: string; runId: string; apiUrl: string; token: string;
}) {
  const request = reviewTaskRequest(input.arguments, input.issueId, input.agentId);
  const response = await fetch(`${input.apiUrl.replace(/\/+$/, "").replace(/\/api$/, "")}/api${request.path}`, {
    method: request.method, redirect: "error",
    headers: { Authorization: `Bearer ${input.token}`, "Content-Type": "application/json", "X-Paperclip-Run-Id": input.runId },
    ...("body" in request ? { body: JSON.stringify(request.body) } : {}), signal: AbortSignal.timeout(30_000),
  });
  if (Number(response.headers.get("content-length")) > 512 * 1024) throw badRequest("Review response exceeds limit");
  const reader = response.body?.getReader();
  if (!reader) throw badRequest("Review response missing");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 512 * 1024) throw badRequest("Review response exceeds limit");
      chunks.push(chunk.value);
    }
  } finally { await reader.cancel(); }
  let result: unknown;
  try { result = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw badRequest(`Review response is not JSON (${response.status})`); }
  if (!response.ok) throw badRequest(result !== null && typeof result === "object" && "error" in result && typeof result.error === "string"
    ? result.error : `Review request failed (${response.status})`);
  if (result === null || typeof result !== "object") throw badRequest(`Review response is not an object (${response.status})`);
  return Array.isArray(result) ? { items: result } : result;
}
