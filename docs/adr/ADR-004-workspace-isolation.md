# ADR-004: Workspace isolation via Git worktrees

- **Status:** accepted
- **Date:** 2026-09-17
- **Plan refs:** §5, §19, §21
- **Threats:** T19, T9, T20

## Context

Complex agent work must never mutate the user's primary tree directly; we need cheap,
auditable isolation with rollback.

## Decision

Task workspaces are **isolated Git worktrees on task branches**, created after checkpoint:

```text
status → diff → checkpoint(record base SHA + dirty state) → worktree add → agent edits
→ tests/scans → review → user approval → merge → worktree cleanup (archivable)
```

Fs jail (Level 1) pins the agent to the worktree root. Simple low-risk tasks may use an
in-place exception only if explicitly configured per project, still checkpointed.

## Consequences

- `packages/git`: checkpoint, worktree create/archive/remove, diff, rollback, merge helpers.
- `packages/storage`: workspace records (project, branch, base SHA, state, agent/model).
- Never destroy uncommitted user changes: dirty primary tree blocks auto-checkpoint paths
  that would endanger it.

## Alternatives considered

- **In-place edits with undo log**: rejected for complex tasks — no true isolation, weak rollback.
- **Container-per-task from day one**: deferred to Level 3 for high-risk commands; worktrees
  give isolation semantics every Git project already supports.

## Security considerations

Traversal (T9) contained by worktree jail; destructive accidents (T19) bounded by checkpoint +
approval + rollback tests. Cross-project leakage (T20): one workspace ⇄ one project.
