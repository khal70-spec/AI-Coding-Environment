# Runbook — Upgrade (P9.4/P9.6)

Upgrades advance by migration version, not by reinstall. State persists in `app.db`.

## Procedure

1. Back up the db (see `backup-restore.md`).
2. Ensure the tree is exactly the release artifact:
   `node scripts/release-verify.mjs` (byte-identical rebuild check).
3. Apply migrations: `node scripts/db-migrate.mjs` (idempotent; additive-only by policy
   gate `scripts/migration-check.mjs`).
4. Run the readiness matrix: `node scripts/release-check.mjs` — every row PASS.

## Downgrade

Older builds run against newer additive schemas (extra columns ignored). Never run a
build older than its own migration series against a database it cannot understand if a
BREAKING policy change ever gets introduced — today, no such migration exists (M1-M3
forbidden mechanically).

## First-boot of a fresh checkout

```bash
npm ci --ignore-scripts     # exact-pinned dev deps only
npm test                    # full gate
node scripts/security-gate.mjs
node scripts/release-check.mjs
```
