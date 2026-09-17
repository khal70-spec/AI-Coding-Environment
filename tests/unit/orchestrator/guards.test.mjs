// Unit: orchestrator transition guards (ADR-007).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { guardTransition } from "../../../packages/orchestrator/src/index.ts";

const approval = { by: "user", at: "2026-09-17T00:00:00Z", scope: "TESTONLY" };

describe("guards", () => {
  it("denies illegal transitions even with full context", () => {
    const r = guardTransition("IMPLEMENTING", "MERGED", { risk: "low", testsGreen: true, scansGreen: true });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "ILLEGAL_TRANSITION");
  });

  it("requires plan approval for medium/high before workspace prep", () => {
    const denied = guardTransition("WAITING_APPROVAL", "PREPARING_WORKSPACE", { risk: "high" });
    assert.equal(denied.ok, false);
    const okLow = guardTransition("WAITING_APPROVAL", "PREPARING_WORKSPACE", { risk: "low" });
    assert.equal(okLow.ok, true);
    const okApproved = guardTransition("WAITING_APPROVAL", "PREPARING_WORKSPACE", { risk: "high", planApproval: approval });
    assert.equal(okApproved.ok, true);
  });

  it("requires checkpoint before implementing", () => {
    const denied = guardTransition("PREPARING_WORKSPACE", "IMPLEMENTING", { risk: "low" });
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, "CHECKPOINT_REQUIRED");
  });

  it("bounds the fix loop", () => {
    const denied = guardTransition("FIXING", "IMPLEMENTING", { risk: "low", checkpointSha: "abc", fixAttempts: 3 });
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, "RETRY_BUDGET_EXHAUSTED");
  });

  it("requires green verify + independent review + approval to merge", () => {
    const base = { risk: "medium", planApproval: approval, checkpointSha: "abc", finalApproval: approval,
      implementer: "implementer", reviewer: "code-reviewer" };
    assert.equal(guardTransition("APPROVED", "MERGED", { ...base }).ok, false); // tests not green
    assert.equal(guardTransition("APPROVED", "MERGED", { ...base, testsGreen: true }).ok, false); // scans not green
    const okAll = guardTransition("APPROVED", "MERGED", { ...base, testsGreen: true, scansGreen: true });
    assert.equal(okAll.ok, true);
    const selfReview = guardTransition("APPROVED", "MERGED",
      { ...base, testsGreen: true, scansGreen: true, reviewer: "implementer" });
    assert.equal(selfReview.ok, false); // implementer cannot sole-review
  });
});
