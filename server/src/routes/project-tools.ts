import { Router } from "express";
import { agents, type Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { callReviewTaskTool, reviewTaskTool } from "../services/review-task-tools.js";
import { projectToolContext } from "../services/project-tool-context.js";
import { callProjectTool, projectToolDefinitions } from "../services/project-tools.js";
import { assertCompanyAccess } from "./authz.js";
import { forbidden } from "../errors.js";

/** Mounted after actor middleware; connection-scoped tokens cannot authenticate here. */
export function projectToolRoutes(db: Db) {
  const router = Router();
  router.post("/mcp/project-tools", async (req, res) => {
    const context = await projectToolContext(db, req.actor);
    assertCompanyAccess(req, context.run.companyId);
    const [agent] = await db.select({ config: agents.adapterConfig }).from(agents)
      .where(and(eq(agents.id, context.run.agentId), eq(agents.companyId, context.run.companyId)));
    const readOnlyReview = context.run.contextSnapshot?.paperclipReviewReadOnly === true || agent?.config?.reviewReadOnly === true;
    const { id = null, method, params } = req.body;
    const send = (result: unknown) => res.json({ jsonrpc: "2.0", id, result });
    if (method === "initialize") return send({ protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "paperclip-project-tools", version: "1" } });
    if (method === "notifications/initialized") return res.status(202).end();
    const definitions = readOnlyReview ? [reviewTaskTool] : projectToolDefinitions(context.issue.workMode, true);
    if (method === "tools/list") return send({ tools: definitions });
    if (method !== "tools/call") return res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
    try {
      if (!definitions.some(tool => tool.name === params?.name)) throw forbidden("Tool is unavailable in this mode");
      const apiUrl = process.env.PAPERCLIP_API_URL;
      if (!apiUrl) throw new Error("Paperclip API origin is unavailable");
      const token = req.header("authorization")!.replace(/^Bearer\s+/i, "");
      const result = readOnlyReview ? await callReviewTaskTool({ arguments: params.arguments ?? {}, apiUrl, token,
        issueId: context.issue.id, agentId: context.run.agentId, runId: context.run.id }) : await callProjectTool({
        name: params.name, arguments: params.arguments ?? {}, apiUrl,
        token,
        companyId: context.run.companyId, issueId: context.issue.id, agentId: context.run.agentId,
        conversation: Boolean(context.issue.conversationAgentId),
      });
      return send({ content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result });
    } catch (error) {
      return send({ isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Project tool failed" }] });
    }
  });
  return router;
}
