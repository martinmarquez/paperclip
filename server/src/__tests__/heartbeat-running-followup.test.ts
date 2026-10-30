import { describe, expect, it } from "vitest";
import { shouldQueueFollowupForRunningIssueWake } from "../services/heartbeat.ts";
import { decideWakeAdmission } from "../modules/wake-queue/domain/policy.js";

describe("shouldQueueFollowupForRunningIssueWake", () => {
  it("defers an explicit self-resume until the current turn releases the issue", () => {
    const shouldQueueFollowupForRunningWake = shouldQueueFollowupForRunningIssueWake({
      contextSnapshot: { wakeReason: "issue_resumed" }, wakeCommentId: null,
    });
    expect(shouldQueueFollowupForRunningWake).toBe(true);
    expect(decideWakeAdmission({
      isSameExecutionAgent: true, shouldDeferFollowupWake: false,
      shouldQueueFollowupForRunningWake, availableActiveExecutionRunPresent: true,
    })).toEqual({ kind: "defer" });
  });

  it("preserves a deferred fallback while the source turn is still running", () => {
    expect(shouldQueueFollowupForRunningIssueWake({
      contextSnapshot: {
        wakeReason: "issue_commented",
        interactionId: "00000000-0000-4000-8000-000000000001",
        interactionStatus: "accepted",
      },
      wakeCommentId: null,
    })).toBe(true);
  });

  it("still coalesces a generic issue wake without new input", () => {
    expect(shouldQueueFollowupForRunningIssueWake({
      contextSnapshot: { wakeReason: "issue_commented" },
      wakeCommentId: null,
    })).toBe(false);
  });
});
