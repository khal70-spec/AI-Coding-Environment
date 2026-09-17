# Phase 1 — Core Runtime (Plan §54.5–7, §5, §21, §26, §30)

**Gate**: project/workspace manager + task engine + real Git safety layer + SQLite DAOs +
audit store, all offline-runnable via CLI, with integration (fs/Git/SQLite) and security
(traversal, rollback, scoping) tests green.

Driver decision: ADR-009 (`node:sqlite` — zero-dep, matches engines, CI matrix 22/24).

## P1.1 SQLite runtime (Plan §30, ADR-008/009)

- [x] Shared migration runner (`packages/storage/src/migrate.ts`) used by both
  `scripts/db-migrate.mjs` and the app boot path (no duplicated migration logic)
- [x] `Database` opening helper (WAL, foreign keys, mkdir, migrate-on-open)
- [x] Typed DAOs: projects, tasks, runs, workspaces, audit
- [x] Audit store is structurally append-only (no update/delete methods shipped)
- [x] No secret values in any DAO path (`vault://` refs only)

## P1.2 Git safety runtime (Plan §21, ADR-004)

- [x] `GitRunner`: argv-only execution via `execFile` (never shell), cwd pinned to repo
- [x] Pre-spawn guards: `isDestructiveGitArgs` + command classifier — blocked shapes
  never reach `execFile`
- [x] Output redaction on every capture (secrets never leave in logs)
- [x] Checkpoint record: SHA + branch + dirty state (never destroys user changes)
- [x] Worktree lifecycle: add → task branch checkout → list → remove
- [x] Protected-branch push gate (unchanged policy; no push implemented in Phase 1)

## P1.3 Task engine + state machine wiring (Plan §32/§33, ADR-007)

- [x] `TaskEngine.transition()` — guard → state write → run row → audit event;
  denied attempts are denied AND audited
- [x] `nextHappyPath()` forward-edge resolution (explicit `to` for fix loops)
- [x] Guard-context assembly from the audit trail (approvals, checkpoint SHA, verify
  evidence, fix-attempt budget) — audit is the evidence store
- [x] Workspace preparation: checkpoint → isolated worktree → workspace row → audit

## P1.4 CLI (offline operator/CI surface)

- [x] `aice migrate` — apply DB migrations
- [x] `aice project create|list|archive` — project container management
- [x] `aice task create|list|show|advance|fail` — task lifecycle on the state machine
- [x] `aice approve plan|final` — risk-gated approvals (Plan §33)
- [x] `aice checkpoint`, `aice workspace prepare`, `aice verify`, `aice review` — evidence commands
- [x] `aice audit` — task/project audit trail (redacted output)
- [x] `--json` output on list/show for CI scripting

## P1.5 Tests (Plan §46)

- [x] `tests/unit/storage` — DAO CRUD, append-only audit structure, migration sharing
- [x] `tests/unit/orchestrator` — engine transitions, denial auditing, ctx assembly
- [x] `tests/unit/git` — runner blocks destructive argv before spawn
- [x] `tests/integration` — full CLI lifecycle on a real git fixture; SQLite live-DB
  assertions match the table inventory
- [x] `tests/security` — worktree traversal escape denied, rollback path enforced,
  project scoping isolation, raw-shell rejection

## P1.6 Tooling + docs

- [x] `typescript@5.9.3` dev-dep (pinned) — real `npm run typecheck` (strict, noEmit)
- [x] ADR-009 driver decision; ADR index updated
- [x] README/tech-stack/getting-started/CLI docs updated
- [ ] ESLint flat config + `typescript-eslint` (advisory; blocking in Phase 3 hardening wave)
- [ ] CI workflow install (blocked on token `workflows` permission — `scripts/ci/README.md`)
