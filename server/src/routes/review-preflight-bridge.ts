import { Router, type Request } from "express";
import { z } from "zod";
import { assertCompanyAccess } from "./authz.js";
import {
  authorizeRead, authorizeRun, boundedOperation, collectDiagnostic, evidenceFresh, reserveRequest, subjectSchema,
  type BridgeDependencies, type Principal,
} from "../services/review-preflight-bridge.js";

const keySchema = z.string().min(16).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const requestIdSchema = z.string().uuid();

// Mounted only when the host explicitly supplies reviewed adapters and scope.
export function reviewPreflightBridgeRoutes(deps: BridgeDependencies, recordActivity: (req: Request, entry: {
  action: "review_preflight.reserved" | "review_preflight.evidence_stored";
  requestId: string;
}) => Promise<void>) {
  const router = Router();
  if (!deps.enabled) return router;

  router.post("/companies/:companyId/review-preflight-extractions", async (req, res) => {
    const companyId = String(req.params.companyId);
    assertCompanyAccess(req, companyId);
    const budget = requestBudget(deps, res);
    let requestId: string | null = null;
    try {
    const principal = principalFromRequest(req);
    if (!principal || !await budget.call((signal) => authorizeRun(deps, principal, companyId, signal))) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    if (!deps.verifyOrigin(req.get("origin"))) {
      res.status(403).json({ error: "origin_denied" });
      return;
    }
    const body = z.strictObject({}).safeParse(req.body);
    const key = keySchema.safeParse(req.get("idempotency-key"));
    if (!body.success || !key.success) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    const subject = subjectSchema.safeParse(deps.subject);
    if (!subject.success) { res.status(503).json({ error: "subject_unknown" }); return; }
    const result = await budget.call((signal) => reserveRequest(deps, principal, subject.data, key.data, signal));
    if (result.kind === "conflict") { res.status(409).json({ error: "idempotency_conflict" }); return; }
    if (result.kind === "pending_unresolved") {
      res.status(409).json({ error: "pending_unresolved", dispatchAllowed: false });
      return;
    }
    if (result.kind === "rate_limited") {
      res.set("Retry-After", String(result.retryAfterSeconds)).status(429).json({ error: "rate_limited" });
      return;
    }
    if (result.kind !== "created" && result.kind !== "existing") return;
    const { reservation } = result;
    requestId = reservation.id;
    if (result.kind === "created") {
      await budget.call(() => recordActivity(req, { action: "review_preflight.reserved", requestId: reservation.id }));
      let publicationUncertain = false;
      try {
        const extraction = deps.readerForSession
          ? { ...deps, reader: deps.readerForSession(req.headers.cookie ?? "") }
          : deps;
        const evidence = await collectDiagnostic(extraction, principal, reservation, budget.signal);
        if (evidence) {
          const stored = await budget.call((signal) => deps.store.publishHold({ requestId: reservation.id, companyId, actorId: principal.id, evidence },
            async (guardSignal) => await authorizeRun(deps, principal, companyId, guardSignal)
              && (deps.now ?? (() => new Date()))().getTime() < Date.parse(reservation.expiresAt)
              && evidenceFresh(evidence, (deps.now ?? (() => new Date()))()), signal));
          if (stored) await budget.call(() => recordActivity(req, { action: "review_preflight.evidence_stored", requestId: reservation.id }));
        }
      } catch {
        // Never replay an uncertain extraction, and never return raw source errors.
        publicationUncertain = true;
      }
      if (publicationUncertain) {
        res.status(202).json({ requestId, status: "uncertain", dispatchAllowed: false });
        return;
      }
    }
    const latest = await budget.call((signal) => deps.store.get(companyId, reservation.id, signal));
    res.status(202).json({ requestId: reservation.id, status: latest?.status ?? "pending", dispatchAllowed: false });
    } catch {
      // A reserve or publication may have committed after its response was lost.
      if (!res.headersSent) res.status(requestId ? 202 : 503).json({
        ...(requestId ? { requestId } : {}), status: "uncertain", dispatchAllowed: false,
      });
    } finally { budget.close(); }
  });

  router.get("/companies/:companyId/review-preflight-extractions/:requestId", async (req, res) => {
    const companyId = String(req.params.companyId);
    assertCompanyAccess(req, companyId);
    const budget = requestBudget(deps, res);
    try {
    const requestId = requestIdSchema.safeParse(req.params.requestId);
    if (!requestId.success) { res.status(404).json({ error: "not_found" }); return; }
    const principal = principalFromRequest(req);
    if (!principal || !await budget.call((signal) => authorizeRead(deps, principal, companyId, requestId.data, signal))) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    const reservation = await budget.call((signal) => deps.store.get(companyId, requestId.data, signal));
    if (!reservation) { res.status(404).json({ error: "not_found" }); return; }
    if ((deps.now ?? (() => new Date()))().getTime() >= Date.parse(reservation.expiresAt)) {
      res.status(410).json({ error: "expired" });
      return;
    }
    if (!await budget.call((signal) => authorizeRead(deps, principal, companyId, requestId.data, signal))) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    if ((deps.now ?? (() => new Date()))().getTime() >= Date.parse(reservation.expiresAt)) {
      res.status(410).json({ error: "expired" });
      return;
    }
    res.json({
      requestId: reservation.id,
      status: reservation.status,
      expiresAt: reservation.expiresAt,
      evidence: reservation.evidence && evidenceFresh(reservation.evidence, (deps.now ?? (() => new Date()))())
        ? reservation.evidence : null,
      decision: "HOLD",
      dispatchAllowed: false,
    });
    } catch {
      if (!res.headersSent) res.status(503).json({ error: "read_uncertain", dispatchAllowed: false });
    } finally { budget.close(); }
  });

  return router;
}

function requestBudget(deps: BridgeDependencies, res: import("express").Response) {
  const controller = new AbortController();
  const limits = deps.ioLimits ?? { totalMs: 60_000, callMs: 5_000 };
  const totalMs = Number.isFinite(limits.totalMs) && limits.totalMs > 0 ? Math.min(limits.totalMs, 60_000) : 1;
  const callMs = Number.isFinite(limits.callMs) && limits.callMs > 0 ? Math.min(limits.callMs, 5_000) : 1;
  const timer = setTimeout(() => controller.abort(), totalMs);
  const disconnect = () => controller.abort();
  res.once("close", disconnect);
  return {
    signal: controller.signal,
    call: <T>(operation: (signal: AbortSignal) => Promise<T>) => boundedOperation(controller.signal, callMs, operation),
    close: () => { clearTimeout(timer); res.off("close", disconnect); controller.abort(); },
  };
}

function principalFromRequest(req: import("express").Request): Principal | null {
  const actor = req.actor;
  if (actor.type === "board" && actor.userId && actor.source === "session") {
    return { type: "board", id: actor.userId, source: actor.source ?? "unknown", keyId: actor.keyId };
  }
  if (actor.type === "agent" && actor.agentId && actor.source === "agent_jwt" && !actor.keyId) {
    return { type: "agent", id: actor.agentId, source: actor.source ?? "unknown", keyId: actor.keyId };
  }
  return null;
}
