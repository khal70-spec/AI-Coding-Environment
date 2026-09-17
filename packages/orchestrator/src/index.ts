// @ai-coding-env/orchestrator — Plan §7/§32/§33, ADR-007.
// Transition GUARDS over the core machine: approvals, checkpoints, green verify,
// independent review. Pure logic; persistence + execution arrive in Phase 1/4.
import type { AgentId, ModelId, RiskLevel, TaskState } from "../../core/src/index.ts";
import { canTransition, fail, ok } from "../../core/src/index.ts";
import type { Result } from "../../core/src/index.ts";

export interface Approval {
  readonly by: "user";
  readonly at: string;
  readonly scope: string;
}

export interface GuardContext {
  readonly risk: RiskLevel;
  readonly planApproval?: Approval;
  readonly finalApproval?: Approval;
  readonly checkpointSha?: string;
  readonly testsGreen?: boolean;
  readonly scansGreen?: boolean;
  readonly implementer?: AgentId;
  readonly implementerModel?: ModelId;
  readonly reviewer?: AgentId;
  readonly reviewerModel?: ModelId;
  readonly fixAttempts?: number;
}

export const MAX_FIX_ATTEMPTS = 3;

function need(cond: boolean, code: string, message: string, remediation?: string): Result<true> | null {
  if (cond) return null;
  return fail(code, message, remediation);
}

/**
 * Authorize a state transition. Returns ok(true) when the edge exists in the core
 * machine AND all guards for the destination pass. Fail-closed otherwise.
 */
export function guardTransition(from: TaskState, to: TaskState, ctx: GuardContext): Result<true> {
  if (!canTransition(from, to)) {
    return fail("ILLEGAL_TRANSITION", `transition ${from} → ${to} is not in the state machine`, "Follow the ADR-007 lifecycle; invalid jumps are denied and audited.");
  }
  // Terminal-failure exits are always structurally allowed (audited by caller).
  if (to === "BLOCKED" || to === "CANCELLED" || to === "FAILED" || to === "ROLLBACK_REQUIRED") {
    return ok(true);
  }
  switch (to) {
    case "PREPARING_WORKSPACE": {
      const err = need(ctx.planApproval !== undefined || ctx.risk === "low", "APPROVAL_REQUIRED",
        "plan approval required before preparing workspace",
        "Medium/high-risk tasks need explicit user plan approval (Plan §33).");
      if (err !== null) return err;
      break;
    }
    case "IMPLEMENTING": {
      const err =
        need(ctx.checkpointSha !== undefined && ctx.checkpointSha.length > 0, "CHECKPOINT_REQUIRED",
          "checkpoint SHA required before implementation",
          "Run git status → diff → checkpoint → worktree first (Plan §21).") ??
        (from === "FIXING"
          ? need((ctx.fixAttempts ?? 0) < MAX_FIX_ATTEMPTS, "RETRY_BUDGET_EXHAUSTED",
            `fix loop exceeded ${MAX_FIX_ATTEMPTS} attempts`, "Escalate to user or fail the task.")
          : null);
      if (err !== null) return err;
      break;
    }
    case "APPROVED": {
      const err = need(ctx.finalApproval !== undefined || ctx.risk === "low", "APPROVAL_REQUIRED",
        "final approval required before merge",
        "Medium/high-risk tasks need explicit user approval of the verified diff.");
      if (err !== null) return err;
      break;
    }
    case "MERGED": {
      const err =
        need(ctx.testsGreen === true, "VERIFY_REQUIRED", "tests must be green before merge") ??
        need(ctx.scansGreen === true, "VERIFY_REQUIRED", "security scans must be green before merge") ??
        need(ctx.reviewer !== undefined && ctx.reviewer !== ctx.implementer, "INDEPENDENT_REVIEW_REQUIRED",
          "implementer cannot be the sole reviewer",
          "An independent reviewer agent must approve the final diff (Plan §3.6).");
      if (err !== null) return err;
      break;
    }
    default:
      break;
  }
  return ok(true);
}
