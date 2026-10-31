import { createHash } from "node:crypto";
import type { BoardHostReader, BridgeScope, SourceKind } from "./review-preflight-bridge.js";

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value)
  ? value as JsonObject : {};
const array = (value: unknown): unknown[] => { if (!Array.isArray(value)) throw new Error("preflight_source_shape"); return value; };
const text = (value: unknown): string => { if (typeof value !== "string") throw new Error("preflight_source_shape"); return value; };

export interface BoardReaderOptions {
  scope: BridgeScope;
  internalOrigin: string;
  auditWindow: { from: string; to: string };
  cookie: string;
  readManifest: BoardHostReader["readManifest"];
  fetch?: typeof fetch;
}

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.ok || !response.headers.get("content-type")?.includes("application/json") || !response.body) {
    await response.body?.cancel();
    throw new Error("preflight_source_unavailable");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 128 * 1024) throw new Error("preflight_source_limit");
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// These DTOs exclude credentials before hashing or entering the evidence collector.
export function projectBoardSource(kind: SourceKind, raw: unknown, scope: BridgeScope): unknown {
  const value = object(raw);
  if (kind === "configuration") {
    const config = object(value.adapterConfig);
    return { adapterType: text(value.adapterType), cwd: text(config.cwd),
      sandbox: config.dangerouslyBypassApprovalsAndSandbox === true ? "bypass" : "configured" };
  }
  if (kind === "keys") return array(raw).map((item) => {
    const key = object(item);
    return { id: text(key.id), scope: typeof key.scope === "string" ? key.scope : String(object(key.scopeConfig).kind ?? "standard"),
      createdAt: text(key.createdAt), revokedAt: key.revokedAt === null ? null : text(key.revokedAt) };
  });
  if (kind === "profile") return {
    profileNames: array(value.profiles).map((item) => text(object(item).name)),
    bindingNames: array(value.bindings).map((item) => text(object(item).id)),
  };
  if (kind === "environment") return {
    names: array(raw).map((item) => text(object(item).name)),
    drivers: array(raw).map((item) => text(object(item).driver)),
  };
  const events = array(value.rows ?? value.items).map(object)
    .filter((event) => scope.reviewerIds.includes(String(event.agentId ?? event.actorId)));
  return { events: events.map((event) => ({ id: text(event.id), actorId: text(event.actorId), action: text(event.action) })),
    nextCursor: value.nextCursor == null ? null : text(value.nextCursor) };
}

export function createBoardSessionReader(options: BoardReaderOptions): BoardHostReader {
  const origin = new URL(options.internalOrigin);
  if (origin.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(origin.hostname)
    || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash
    || !options.cookie || /[\r\n]/.test(options.cookie)) throw new Error("preflight_transport_configuration");
  if (!Number.isFinite(Date.parse(options.auditWindow.from)) || !Number.isFinite(Date.parse(options.auditWindow.to))
    || Date.parse(options.auditWindow.from) >= Date.parse(options.auditWindow.to)) throw new Error("preflight_audit_window");
  return {
    readManifest: options.readManifest,
    async read(kind, agentId, cursor, signal) {
      if (agentId !== null && !options.scope.reviewerIds.includes(agentId)) throw new Error("preflight_source_scope");
      if ((kind === "environment" || kind === "audit") !== (agentId === null)) throw new Error("preflight_source_scope");
      if ((cursor !== null && cursor.length > 500) || (kind !== "audit" && cursor !== null)) throw new Error("preflight_source_scope");
      const company = `/api/companies/${options.scope.companyId}`;
      const paths: Record<SourceKind, string> = {
        configuration: `/api/agents/${agentId}/configuration`, keys: `/api/agents/${agentId}/keys`,
        profile: `${company}/tools/profiles/effective/agents/${agentId}`,
        environment: `${company}/environments`, audit: `${company}/audit/agent-actions`,
      };
      const url = new URL(paths[kind], origin);
      if (kind === "audit") {
        url.searchParams.set("from", options.auditWindow.from);
        url.searchParams.set("to", options.auditWindow.to);
        url.searchParams.set("limit", "50");
        if (cursor) url.searchParams.set("cursor", cursor);
      }
      signal.throwIfAborted();
      const response = await (options.fetch ?? fetch)(url, { method: "GET", redirect: "error", signal,
        headers: { cookie: options.cookie, accept: "application/json" } });
      const data = projectBoardSource(kind, await readJson(response, signal), options.scope);
      const hash = createHash("sha256").update(JSON.stringify(data)).digest("hex");
      return { data, observation: { observedAt: new Date().toISOString(), sourceRevision: `native-http:${hash}`,
        sourceHash: hash, status: "PASS" } };
    },
  };
}
