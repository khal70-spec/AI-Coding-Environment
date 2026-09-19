# Runbook — Backup & Restore (P9.2)

The governed SQLite db is the system of record. Backups are **verified before they are
trusted**; restores are **verified before they replace anything**.

## Back up

```bash
DB_PATH=.local/app.db node scripts/db-backup.mjs [--out DIR]
```

Mechanism: `WAL checkpoint(TRUNCATE)` (busy writers → refuses) → atomic copy → the copy
is opened and verified (`integrity_check`, `foreign_key_check`, migration max, row
counts) → only then renamed into place as `app-<UTC-stamp>.db`.

## Restore

```bash
DB_PATH=.local/app.db node scripts/db-restore.mjs <backup-file>
```

Guards: candidate verified first (`integrity_check` + `foreign_key_check`; a malformed
file is refused with a message, never a stack trace) → the CURRENT db is itself
safety-copied to `backups/app-prerestore-<stamp>.db` → atomic replace → post-restore
verification printed verbatim.

## Disaster drills

- Quarterly: restore the newest backup into a scratch path (`DB_PATH=/tmp/drill.db`) and
  run `aice doctor` + `aice task list` against it.
- After upgrading Node or the app: restore the pre-upgrade safety copy if the upgrade
  fails; migrations are **additive-only** (enforced by `scripts/migration-check.mjs`), so
  downgrades keep their data — new columns are simply ignored by the older build.

## Verify a restore kept the walk

`tests/integration/release-workflow.test.mjs` §10 proves audit monotonicity survives
backup → mutate → restore. Re-run anytime: `node --test tests/integration/backup-restore.test.mjs`.
