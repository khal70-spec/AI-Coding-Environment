# Phase 1 Phase-Gate Review — 2026-09-17

**Gate** (per `docs/backlog/phase-1-core-runtime.md` P1.6): threat-model re-read,
Definition-of-Done spot check, decision to open Phase 2.
**Evidence base**: commit `717256e` — 179/179 tests (35 suites), 13/13 workspace suites,
strict `tsc --noEmit` clean, `check:secrets` clean (125 files), `npm audit` 0 vulns,
migration idempotency + schema drift guard green.

## 1. Threat-model re-read (changed posture vs Phase 0)

| Threat | Phase 1 posture | Runtime evidence | Residual risk |
|---|---|---|---|
| T5 stolen API key | Unchanged (handle-only vault; no keys exist yet) | `secret-redaction` suites, `check:secrets` | Accept → Phase 2 gets OS vault adapters |
| T6 compromised provider | No provider I/O yet; models untrusted by design | policy matrix | Accept → Phase 2 wires redaction + classification gates |
| T8 shell command injection | **Runner live**: argv-only `GitRunner`, `BLOCKED_COMMAND` thrown pre-spawn, `GIT_TERMINAL_PROMPT=0`, output redacted | `git/runner` unit, `cli-shell-safety` | ✅ accepted |
| T9 path traversal | **Hardened**: missing-target fallback realpaths deepest existing ancestor — symlinked-parent jailbreak caught by own test | `path-traversal`, `workspace-isolation` | ✅ accepted (strengthened) |
| T19 accidental destruction | **Runtime live**: checkpoint → isolated worktree under `<project>/.aice/worktrees/`; destructive git argv blocked; rollback branch integrity tested | `rollback-enforcement`, `cli-lifecycle` | ✅ accepted |
| T20 cross-project leakage | **DAO live**: project-scoped list queries; cross-project prepare denied (FAIL_CLOSED) | `project-scoping` | ✅ accepted |
| Task-guard bypass | Denials audited exactly once; state unchanged; high-risk approval denial end-to-end | `orchestrator/engine`, `rollback-enforcement`, `cli-lifecycle` | ✅ accepted |
| All other threats (T1–T4, T7, T10–T18) | Posture unchanged from Phase 0 review (kernel-level or later-phase deliverables) | as per phase-0-gate-review.md | accepted as phased |

**New finding this phase (self-caught, fixed before commit)**: `assertContainedSync`
trusted lexical paths for not-yet-existing targets; a symlinked ancestor could redirect
a worktree outside the project jail. Fixed in `packages/security/src/paths.ts`
(realpath the deepest existing ancestor, pin the remaining suffix). Covered by
`tests/security/workspace-isolation.test.mjs`.

## 2. Definition-of-Done spot check (Plan §51 — subset newly testable in Phase 1)

| DoD item | Phase 1 status |
|---|---|
| No critical/high vulns | ✅ `npm audit` clean (typescript/@types/node only new dev deps, exact-pinned) |
| Keys secure / never in DB or logs | ✅ unchanged from Phase 0 (no key storage yet) |
| Rollback runtime | ✅ `ROLLBACK_REQUIRED` enforced; synthetic-integrity scenario passes; denial audited |
| Isolated workspaces | ✅ checkpoint → worktree → audit; symlink-ancestor jailbreak closed |
| Dangerous ops gated | ✅ plan/final approvals, verify, review gates enforced with audit on denial |
| Auditability | ✅ append-only `AuditDao` (no update/delete — source-scan test); `task show`/`audit` CLI reads |
| Type safety | ✅ strict `tsc` blocking gate over all `src` |
| CI gates | ⚠️ unchanged: workflow authored + local equivalent proven; GitHub install blocked on App `workflows` permission — accepted open item |

## 3. Decision

Phase 1 is **complete**. Phases remaining per `docs/backlog/phases-1-9.md`;
residual risks above are phase-scoped and map to Phase 2+ deliverables.
Open items carried into Phase 2: ESLint flat config (scheduled Phase 3), CI workflow
installation (external permission blocker), CLI provider surface (Phase 2 P2.4).

Tag `phase-1-complete` set; Phase 2 backlog opened:
`docs/backlog/phase-2-provider-framework.md`.

**Signed off**: 2026-09-17, gate review by agent-mode audit workflow (evidence cited above).
