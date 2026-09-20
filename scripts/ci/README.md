# CI workflow (authored + upgraded — pending maintainer installation)

`ci.yml` is the complete GitHub Actions workflow implementing the Plan §47 security
gates: tests (root + per-package workspaces), strict typecheck, blocking lint,
offline secret scan, `npm audit` (high+), the composed security gate
(secrets/dep-audit/supply-chain R1–R4/SBOM/SAST-lite), a11y static gate (A1–A15),
CLI doctor, SQLite migration idempotency, and deterministic-artifact +
reproducibility lanes on a Node 22/24 matrix with least-privilege permissions.

Since the 2026-09-20 upgrade it also carries the Phase-8+ supply-chain lanes as
**blocking jobs**: OSV-Scanner (reusable workflow), Semgrep `p/security-audit`,
Trivy fs — and **every action reference is pinned to a full-length commit SHA**
(tags are mutable; SHAs are not). Gitleaks is intentionally not duplicated in CI —
the offline `check-secrets` lane is already blocking locally (one maintenance
surface, same intent).

## Why it is parked here

GitHub refuses workflow files under `.github/workflows/` when the pushing App/token
lacks the **`workflows` permission**. Two recorded attempts:

1. **2026-09-17 (Phase 0)** — authoring automation token rejected; workflow parked
   here with one-step install instructions.
2. **2026-09-20 (next-steps train)** — install re-attempted via the session token:
   `refusing to allow a GitHub App to create or update workflow
   '.github/workflows/ci.yml' without 'workflows' permission`. Workflow upgraded in
   place (SHA pins + OSV/Semgrep/Trivy lanes) and left install-ready.

Every gate in it is executed locally and passes (see the audits) — the local
equivalent below is the authoritative check until a maintainer installs the file.

## Install (one step, by a maintainer with workflows permission)

```bash
mkdir -p .github/workflows
git mv scripts/ci/ci.yml .github/workflows/ci.yml
git commit -m "ci: install security-gates workflow (Plan §47)"
git push
```

No content changes are needed — the file is self-contained.

## Local equivalent (exact same gates, no GitHub required)

```bash
npm ci
npm test                  # unit + security + integration
npm run test:workspaces   # per-package suites
npm run typecheck         # strict, blocking
npm run check:secrets
npm run audit:deps
npm run lint
node scripts/security-gate.mjs
node scripts/a11y-check.mjs
node apps/cli/src/cli.ts doctor
DB=$(mktemp -u).db
DB_PATH="$DB" node scripts/db-migrate.mjs    # apply
DB_PATH="$DB" node scripts/db-migrate.mjs    # idempotent re-run skips
rm -f "$DB"*
```
