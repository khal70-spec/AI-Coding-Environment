# ADR-007: Task state machine (explicit transitions only)

- **Status:** accepted
- **Date:** 2026-09-17
- **Plan refs:** §7, §32, §33
- **Threats:** T12, T18, T19

## Context

Agent workflows need an auditable lifecycle with no hidden jumps — especially around
approval, merge, and failure handling.

## Decision

The orchestrator enforces this exact machine (`packages/orchestrator` + `packages/core`):

```text
CREATED → CLASSIFYING → INVESTIGATING → PLANNING → WAITING_APPROVAL
→ PREPARING_WORKSPACE → IMPLEMENTING → TESTING → SECURITY_REVIEW
→ AI_REVIEW → FIXING → VERIFYING → READY → APPROVED → MERGED
```

- `FIXING` may return to `IMPLEMENTING` (bounded retries) then must re-pass
  `TESTING → SECURITY_REVIEW → AI_REVIEW → VERIFYING`.
- From any pre-`MERGED` state: `→ BLOCKED | CANCELLED | FAILED`.
- `FAILED` with applied changes: `→ ROLLBACK_REQUIRED → (rolled back) → FAILED`.
- Guards: `PREPARING_WORKSPACE` requires checkpoint; `APPROVED` requires human approval
  for medium/high risk; `MERGED` requires green verify + approval + clean reviewers.
- Every transition emits an audit event with actor (user/agent id + model id).

## Consequences

- Pure transition kernel with exhaustive unit tests (valid + invalid transitions).
- UI renders the machine literally (timeline); no separate shadow states.
- Schedules/automation reuse the same machine (T18 containment).

## Alternatives considered

- **Free-form agent loop**: rejected — unauditable, unmergeable, untestable.
- **BPMN/external engine**: rejected — heavy dependency for a fixed small machine.

## Security considerations

Skipped verification (T12/T19) is structurally impossible: terminal states are reachable
only through the guarded path. Invalid-transition attempts are denied + audited.
