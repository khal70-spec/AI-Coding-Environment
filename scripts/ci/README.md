# CI workflow (authored — pending installation)

`ci.yml` is the complete GitHub Actions workflow implementing the Plan §47 security
gates: tests (root + per-package workspaces), offline secret scan, `npm audit` (high+),
soft lint/typecheck, CLI doctor, and SQLite migration idempotency on a Node 22/24 matrix
with least-privilege permissions.

## Why it is parked here

GitHub only refuses workflow files under `.github/workflows/` when the pushing App/token
lacks the **`workflows` permission**. The automation account that authored this file did
not have that permission, so the workflow could not be pushed to its live location.
Every gate in it was executed locally and passes (see the Phase-0 audit).

## Install (one step, by a maintainer with workflows permission)

```bash
mkdir -p .github/workflows
git mv scripts/ci/ci.yml .github/workflows/ci.yml
git commit -m "ci: install security-gates workflow (Plan §47)"
git push
```

No content changes are needed — the file is self-contained. After it lands, update:
`docs/backlog/phase-0-foundation.md` (P0.1 checkbox),
`docs/development/codebase-audit-2026-09-17.md` (finding 2), and `SECURITY.md`
(drop the "pending installation" note).

## Local equivalent (exact same gates, no GitHub required)

```bash
npm ci
npm test                  # unit + security + integration
npm run test:workspaces   # per-package suites
npm run typecheck         # strict, blocking
npm run check:secrets
npm run audit:deps
npm run lint              # advisory until Phase 3
node apps/cli/src/cli.ts doctor
DB=$(mktemp -u).db
DB_PATH="$DB" node scripts/db-migrate.mjs    # apply
DB_PATH="$DB" node scripts/db-migrate.mjs    # idempotent re-run skips
rm -f "$DB"*
```
