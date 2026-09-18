# Phase 9 gate review — Production readiness (Plan §50/51)

**Verdict: DONE (POC-scope release lane).** Definition-of-Done sign-off:
`docs/release/dod-review.md`. Release checklist (machine rows R1–R10):
`docs/release/release-checklist.md`.

## What shipped

| Item | Backlog | Evidence |
|---|---|---|
| Crash recovery | P9.1 | `tests/integration/crash-recovery.test.mjs` (4/4): 40 staggered SIGKILL writer storms — `integrity_check = ok`, 0 fk violations, 25 complete-or-absent survivors (verbatim in test output); kill-after-commit durability; stale `-wal/-shm` reopen; bridge server death mid-POST + restart sharing the db. |
| Backup/migrate | P9.2 | `scripts/db-backup.mjs` (checkpoint → atomic copy → verify-before-rename); `scripts/db-restore.mjs` (candidate verify → pre-restore safety copy → atomic replace → post-verify; corrupt candidates refused with a message, never a stack trace); `scripts/migration-check.mjs` M1–M4; `tests/integration/backup-restore.test.mjs` (4/4) incl. mutation-undo + idempotency. |
| Perf + a11y | P9.3 | `tests/integration/perf-budgets.test.mjs` (3/3) actuals: audit bulk append **13.7ms/1000 rows**, `listByTask` 3.6ms, bridge dispatch median **1.48ms**, CLI doctor/list **~230ms** — all far inside budgets (≥4× headroom, so noise can't flake). `scripts/a11y-check.mjs` (A1–A9): **found and fixed 2 real violations** (click-only table rows) via roving tabindex + Enter/Space activation + `role="button"` + `:focus-visible` outlines; GREEN with zero notes. |
| Deterministic artifact | P9.4 | `scripts/release-prepare.mjs` (git-tree clean gate, archive HEAD-only, mtime-neutral gzip, SHA256SUMS + meta) + `scripts/release-verify.mjs` (sums match + byte-identical rebuild from HEAD). Signed binaries/auto-update → deferred with native shell (see below). |
| Docs §49 | P9.5 | `docs/runbooks/{backup-restore,crash-recovery,upgrade}.md`, `docs/release/{release-checklist,dod-review}.md`, user-guide current, README status updated, dependency-policy v2 + threat-model v2 from Phase 8. |
| Release checklist + DoD | P9.6 | `scripts/release-check.mjs` R1–R10 (rows mirror the checklist 1:1); DoD review per criterion with deferral ownership. |
| §53 golden workflow | P9.7 | `tests/integration/release-workflow.test.mjs` (4/4): doctor → provider/model → project → task → full governed walk **CREATED → MERGED** through every brake (plan approval, checkpoint, tests+scans evidence, final approval, independent review) → bridge cross-check → audit monotonic → backup/restore preserving the walk. |

## Verification highlights (verbatim)

- `#       storm survivors: 25 tasks (complete-or-absent invariant)`
- `#     perf 1000 audit appends           13.7ms`
- `#     perf bridge dispatch x200            295.3ms (median 1.48ms)`
- `#     at approval brake      state=WAITING_APPROVAL` → `#     final                  state=MERGED`
- `npm test` → `# tests 580 / # pass 580 / # fail 0`
- `SECURITY GATE: GREEN` (4/4 lanes) · lint 0 · tsc exit 0

## Additive deferrals (already owned)

1. **Code-signing identity + auto-update** — with the native shell (ADR-001): the
   deterministic-source tarball + byte-identical rebuild proof stands in for operator
   tamper-evidence on this release track.
2. **OSV/Semgrep/SBOM/CI SHA-pinned actions** — dependency-policy v2 CI-side lanes;
   `scripts/ci/ci.yml` already invokes `npm run security:gate` where installed.
3. **Runtime AT a11y testing** — static gate covers structure; AT review is a manual
   checklist item on the native-shell port.
4. **Multilingual injection detector + unicode-steganography hygiene** — threat-model
   residual risks #1–#3, with their compensating controls documented.
5. **Sandbox re-clone geometry** (operational, not product): this phase experienced a
   mid-phase environment re-clone; recovery lane = fetch + `reset --mixed` to the remote
   branch tip (no force-push, no history mutation) — recorded in the gate review for the
   ops runbook series.

## Release-readiness matrix (final state)

`node scripts/release-check.mjs`: **R1–R10 PASS** (run evidence: commit-tag message and
this review; runbook: `docs/runbooks/upgrade.md`).
