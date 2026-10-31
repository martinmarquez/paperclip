import { mkdtemp, writeFile, rm, symlink, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PreflightSqlDatabase } from "@paperclipai/db";
import { createBoardSessionReader, projectBoardSource } from "../services/review-preflight-board-reader.js";
import { createNativePreflightAuthority } from "../services/review-preflight-authority.js";
import { loadReviewPreflightIntegration, readProtectedPreflightJson } from "../services/review-preflight-integration.js";

const companyId = "00000000-0000-4000-8000-000000000010";
const scope = { companyId, prNumber: 100,
  reviewerIds: ["00000000-0000-4000-8000-000000000011", "00000000-0000-4000-8000-000000000012"],
  readerAgentIds: ["00000000-0000-4000-8000-000000000013", "00000000-0000-4000-8000-000000000014"], operatorUserIds: ["board"] } as const;
const subject = { sha: "a".repeat(40), base: "b".repeat(40), tree: "c".repeat(40), bundleHash: "d".repeat(64) };
const options = { scope, cookie: "session=private-sentinel", internalOrigin: "http://127.0.0.1:3100",
  auditWindow: { from: "2026-10-30T00:00:00Z", to: "2026-10-31T00:00:00Z" }, readManifest: async () => null };

describe("native preflight integration", () => {
  it("keeps the bridge absent without protected startup configuration", async () => {
    await expect(loadReviewPreflightIntegration({} as never, 3100, "")).resolves.toBeUndefined();
  });
  it("uses the request session only for a fixed loopback GET and rejects scope expansion before fetch", async () => {
    const fetcher = vi.fn(async () => Response.json({ adapterType: "codex_local", adapterConfig: { cwd: "/source", token: "secret" } }));
    const reader = createBoardSessionReader({ ...options, fetch: fetcher });
    const signal = new AbortController().signal;
    const result = await reader.read("configuration", scope.reviewerIds[0], null, signal);
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(fetcher).toHaveBeenCalledWith(new URL(`/api/agents/${scope.reviewerIds[0]}/configuration`, options.internalOrigin),
      expect.objectContaining({ method: "GET", redirect: "error", signal, headers: { cookie: options.cookie, accept: "application/json" } }));
    await expect(reader.read("configuration", scope.readerAgentIds[0], null, signal)).rejects.toThrow("scope");
    await expect(reader.read("keys", scope.reviewerIds[0], "cursor", signal)).rejects.toThrow("scope");
    expect(fetcher).toHaveBeenCalledTimes(1);
    for (const internalOrigin of ["https://127.0.0.1", "http://example.com", "http://127.0.0.1/path", "http://user@127.0.0.1"]) {
      expect(() => createBoardSessionReader({ ...options, internalOrigin })).toThrow("configuration");
    }
  });

  it("drops key material and filters audit records to both reviewers", () => {
    const keys = projectBoardSource("keys", [{ id: "id", scopeConfig: { kind: "standard", token: "secret" },
      createdAt: "2026-10-30T00:00:00Z", revokedAt: null, keyHash: "secret" }], scope);
    expect(JSON.stringify(keys)).not.toContain("secret");
    expect(projectBoardSource("audit", { items: [
      { id: "a", agentId: scope.reviewerIds[0], actorId: scope.reviewerIds[0], action: "test", details: "secret" },
      { id: "b", agentId: scope.reviewerIds[1], actorId: scope.reviewerIds[1], action: "test" },
      { id: "c", actorId: "unrelated", action: "test" },
    ], nextCursor: null }, scope)).toEqual({ events: [
      { id: "a", actorId: scope.reviewerIds[0], action: "test" }, { id: "b", actorId: scope.reviewerIds[1], action: "test" },
    ], nextCursor: null });
  });

  it("rejects oversized, non-JSON, failed and already-cancelled source reads", async () => {
    for (const response of [new Response("x".repeat(128 * 1024 + 1), { headers: { "content-type": "application/json" } }),
      new Response("not json"), new Response("denied", { status: 403 })]) {
      const reader = createBoardSessionReader({ ...options, fetch: async () => response });
      await expect(reader.read("keys", scope.reviewerIds[0], null, new AbortController().signal)).rejects.toThrow();
    }
    const fetcher = vi.fn();
    const controller = new AbortController(); controller.abort();
    await expect(createBoardSessionReader({ ...options, fetch: fetcher }).read("audit", null, null, controller.signal)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("requires explicit unexpired subject and request grants through a native transaction", async () => {
    let grant: Record<string, unknown> | null = { companyId, subjectSha: subject.sha,
      requestId: "request", expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() };
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[], _signal?: AbortSignal) => ({ rows: [{ scope: grant, now_at: new Date() }] }));
    const transaction = vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work({ query }));
    const db = { query, transaction } as unknown as PreflightSqlDatabase;
    const authority = createNativePreflightAuthority(db, subject);
    const agent = { type: "agent" as const, id: scope.readerAgentIds[0], source: "agent_jwt" };
    expect(await authority.can(agent, "review-preflight:evidence-read", companyId, "request")).toBe(true);
    expect(await authority.can(agent, "review-preflight:evidence-read", companyId, "different")).toBe(false);
    grant = { ...grant, subjectSha: "e".repeat(40) };
    expect(await authority.can(agent, "review-preflight:evidence-read", companyId, "request")).toBe(false);
    grant = { companyId, subjectSha: subject.sha, expiresAt: new Date(Date.now() - 1).toISOString() };
    expect(await authority.can(agent, "review-preflight:run", companyId)).toBe(false);
    grant = { companyId, subjectSha: subject.sha, expiresAt: new Date(Date.now() + 600_000).toISOString() };
    expect(await authority.can(agent, "review-preflight:evidence-read", companyId)).toBe(false);
    expect(await authority.can(agent, "review-preflight:evidence-read", companyId, "")).toBe(false);
    grant = null;
    expect(await authority.can(agent, "review-preflight:run", companyId)).toBe(false);
    expect(query.mock.calls[0]?.[0]).toContain("FOR SHARE OF g, m");
    expect(transaction).toHaveBeenCalled();
  });

  it("refuses symlinks, shared permissions and large protected files", async () => {
    const root = await mkdtemp(join(tmpdir(), "preflight-protected-"));
    try {
      const path = join(root, "config.json");
      await writeFile(path, '{"ok":true}', { mode: 0o600 });
      expect(await readProtectedPreflightJson(path)).toEqual({ ok: true });
      await symlink(path, join(root, "link"));
      await expect(readProtectedPreflightJson(join(root, "link"))).rejects.toThrow();
      await chmod(path, 0o644);
      await expect(readProtectedPreflightJson(path)).rejects.toThrow("protected");
      await chmod(path, 0o600);
      await writeFile(path, "x".repeat(128 * 1024 + 1));
      await expect(readProtectedPreflightJson(path)).rejects.toThrow("protected");
      await expect(readProtectedPreflightJson("relative.json")).rejects.toThrow("protected");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
