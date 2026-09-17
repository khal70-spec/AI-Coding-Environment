# `@ai-coding-env/orchestrator`

Task state machine + coordination (Plan §7/§32/§33, ADR-007).

- **`src/index.ts`** — pure transition GUARDS over `packages/core` (approvals,
  checkpoint, green-verify, independent review, fix-loop budget).
- **`src/engine.ts`** — `TaskEngine`: guarded transition → state write → run row →
  audit event; denied transitions are denied AND audited (fail closed). Guard evidence
  (approvals, checkpoint SHA, verify results, reviewer, fix attempts) is assembled from
  the append-only audit trail — the log is the evidence store. `nextHappyPath()` names
  the single forward edge; explicit `to` for fix loops / blocked-resume.
- **`src/workspace-service.ts`** — `WorkspaceService.prepare()`: advances the read-only
  investigation phases, enforces the plan-approval gate, records a checkpoint, then
  creates the isolated task worktree (`<project>/.aice/worktrees/`) + branch. Any
  failure is audited and moves the task to `BLOCKED` — never a half-prepared task.

Tests: `tests/unit/orchestrator/` (guards, engine), `tests/security/`
(rollback-enforcement, workspace-isolation, project-scoping).
