// TaskEngine — Plan §32/§33, ADR-007. The state machine wired to persistence.
// Every transition: guard check → state write → run row → audit event. Denied attempts
// are denied AND audited (fail closed, evidence first). Guard evidence (approvals,
// checkpoint SHA, verify results, fix-loop budget) is assembled from the AUDIT TRAIL —
// the append-only log is the evidence store, never a hidden side channel.
import type { Result, TaskState } from "../../core/src/index.ts";
import { fail, ok, canTransition } from "../../core/src/index.ts";
import type { Approval, GuardContext } from "./index.ts";
import { guardTransition, MAX_FIX_ATTEMPTS } from "./index.ts";
import type { AuditDao, RunsDao, TasksDao, TaskRow } from "../../storage/src/index.ts";

/** Single forward edge per state; FIXING loops forward to IMPLEMENTING. */
const NEXT_HAPPY_PATH: Readonly<Partial<Record<TaskState, TaskState>>> = Object.freeze({
  CREATED: "CLASSIFYING",
  CLASSIFYING: "INVESTIGATING",
  INVESTIGATING: "PLANNING",
  PLANNING: "WAITING_APPROVAL",
  WAITING_APPROVAL: "PREPARING_WORKSPACE",
  PREPARING_WORKSPACE: "IMPLEMENTING",
  IMPLEMENTING: "TESTING",
  TESTING: "SECURITY_REVIEW",
  SECURITY_REVIEW: "AI_REVIEW",
  AI_REVIEW: "VERIFYING",
  VERIFYING: "READY",
  READY: "APPROVED",
  APPROVED: "MERGED",
  FIXING: "IMPLEMENTING",
});

export function nextHappyPath(from: TaskState): TaskState | null {
  return NEXT_HAPPY_PATH[from] ?? null;
}

export interface EngineDeps {
  readonly tasks: TasksDao;
  readonly runs: RunsDao;
  readonly audit: AuditDao;
}

export interface TransitionRequest {
  readonly taskId: string;
  /** Explicit target (fix loops, BLOCKED resume). Default: next happy-path state. */
  readonly to?: TaskState;
  readonly actor: string;
  /** Extra guard evidence merged over the audit-derived context (tests only/CLI). */
  readonly overrides?: Partial<GuardContext>;
}

export interface TransitionOutcome {
  readonly from: TaskState;
  readonly to: TaskState;
}

function approvalFrom(at: string, actor: string, scope: string): Approval {
  return { by: "user", at, scope: `${scope}:${actor}` };
}

/** Rebuild GuardContext evidence for a task from its audit trail. */
export function assembleGuardContext(task: TaskRow, audit: AuditDao, fixLoops: number): GuardContext {
  const plan = audit.latestByTaskAction(task.id, "approve.plan");
  const fin = audit.latestByTaskAction(task.id, "approve.final");
  const checkpoint = audit.latestByTaskAction(task.id, "checkpoint");
  const verify = audit.latestByTaskAction(task.id, "verify");
  const review = audit.latestByTaskAction(task.id, "review");
  const checkpointSha =
    checkpoint?.detail !== null && checkpoint?.detail !== undefined && typeof checkpoint.detail["sha"] === "string"
      ? checkpoint.detail["sha"]
      : undefined;
  const testsGreen =
    verify?.detail !== null && verify?.detail !== undefined ? verify.detail["testsGreen"] === true : false;
  const scansGreen =
    verify?.detail !== null && verify?.detail !== undefined ? verify.detail["scansGreen"] === true : false;
  const reviewer =
    review?.detail !== null && review?.detail !== undefined && typeof review.detail["agent"] === "string"
      ? (review.detail["agent"] as GuardContext["reviewer"])
      : undefined;
  return {
    risk: task.risk,
    planApproval: plan === undefined ? undefined : approvalFrom(plan.at, plan.actor, "plan"),
    finalApproval: fin === undefined ? undefined : approvalFrom(fin.at, fin.actor, "final"),
    checkpointSha,
    testsGreen,
    scansGreen,
    reviewer,
    fixAttempts: fixLoops,
  };
}

export class TaskEngine {
  private readonly deps: EngineDeps;
  constructor(deps: EngineDeps) {
    this.deps = deps;
  }

  /** Current guard evidence for a task (audit trail + fix-loop budget). */
  guardContext(taskId: string): GuardContext {
    const task = this.deps.tasks.get(taskId);
    return assembleGuardContext(task, this.deps.audit, this.deps.tasks.countFixLoops(taskId));
  }

  /**
   * Attempt one transition. Returns ok({from,to}) or the guard's failure Result —
   * either way an audit event is written (allow|deny).
   */
  transition(req: TransitionRequest): Result<TransitionOutcome> {
    const task = this.deps.tasks.get(req.taskId);
    const from = task.state;
    const to = req.to ?? nextHappyPath(from);
    if (to === null) {
      return fail("TERMINAL_STATE", `task is in terminal state ${from}; no forward transition`);
    }
    const ctx: GuardContext = {
      ...assembleGuardContext(task, this.deps.audit, this.deps.tasks.countFixLoops(req.taskId)),
      ...req.overrides,
    };
    const verdict = guardTransition(from, to, ctx);
    if (!verdict.ok) {
      this.deps.audit.append({
        actor: req.actor,
        action: "task.transition.denied",
        target: req.taskId,
        projectId: task.projectId,
        taskId: req.taskId,
        decision: "deny",
        detail: { from, to, code: verdict.error.code, message: verdict.error.message },
      });
      return fail(verdict.error.code, verdict.error.message, verdict.error.remediation);
    }
    this.deps.tasks.setState(req.taskId, to);
    this.deps.runs.record({ taskId: req.taskId, agent: req.actor, fromState: from, toState: to });
    this.deps.audit.append({
      actor: req.actor,
      action: "task.transition",
      target: req.taskId,
      projectId: task.projectId,
      taskId: req.taskId,
      decision: "allow",
      detail: { from, to },
    });
    return ok({ from, to });
  }

  /** Record a plan/final approval (Plan §33) — exists as an audit event before use. */
  approve(taskId: string, kind: "plan" | "final", actor: string): number {
    const task = this.deps.tasks.get(taskId);
    return this.deps.audit.append({
      actor,
      action: kind === "plan" ? "approve.plan" : "approve.final",
      target: taskId,
      projectId: task.projectId,
      taskId,
      decision: "approval",
      detail: { kind },
    });
  }

  /** Record a checkpoint (SHA + dirty state) for the current task. */
  recordCheckpoint(taskId: string, checkpoint: { sha: string; branch: string; dirty: boolean }, actor: string): number {
    const task = this.deps.tasks.get(taskId);
    return this.deps.audit.append({
      actor,
      action: "checkpoint",
      target: taskId,
      projectId: task.projectId,
      taskId,
      detail: { sha: checkpoint.sha, branch: checkpoint.branch, dirty: checkpoint.dirty },
    });
  }

  /** Record verification evidence (tests/scans) — consumed by the MERGED guard. */
  recordVerify(taskId: string, evidence: { testsGreen: boolean; scansGreen: boolean }, actor: string): number {
    const task = this.deps.tasks.get(taskId);
    return this.deps.audit.append({
      actor,
      action: "verify",
      target: taskId,
      projectId: task.projectId,
      taskId,
      detail: { testsGreen: evidence.testsGreen, scansGreen: evidence.scansGreen },
    });
  }

  /** Record an independent review (Plan §3.6 — reviewer must differ from implementer). */
  recordReview(taskId: string, reviewerAgent: string, actor: string): number {
    const task = this.deps.tasks.get(taskId);
    return this.deps.audit.append({
      actor,
      action: "review",
      target: taskId,
      projectId: task.projectId,
      taskId,
      detail: { agent: reviewerAgent, maxFixAttempts: MAX_FIX_ATTEMPTS },
    });
  }

  /** Structural reachability check used by callers before expensive operations. */
  canMove(taskId: string, to: TaskState): boolean {
    return canTransition(this.deps.tasks.get(taskId).state, to);
  }
}
