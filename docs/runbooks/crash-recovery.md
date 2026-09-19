# Runbook — Crash recovery (P9.1)

## What you will NOT find

Torn task rows, partial audit events, or a wedged database. Writes are single-statement
transactions in WAL mode; commits are durable before the process can die mid-statement.
Death at any instant leaves one of two states: before-commit or after-commit.

## After an abrupt kill

Just restart the app/CLI. Node:sqlite replays the WAL automatically. Diagnostic drill:

```bash
aice doctor                # opens the db, runs integrity + fk checks
node --test tests/integration/crash-recovery.test.mjs   # replays the SIGKILL storm proof
```

Expected evidence lines: `integrity_check = ok`, `foreign_key_check` empty, the storm
suite prints `storm survivors: N tasks (complete-or-absent invariant)`.

## Stale `-wal`/`-shm` files

Normal after kill -9; harmless for the next open. They disappear on the first clean
checkpoint; never delete them manually while the process is dead if you want the last
committed milliseconds of data back — open once, checkpoint via `aice doctor`, done.

## If integrity_check ever reports corruption

1. Do NOT write to the db.
2. Restore the newest clean backup: `node scripts/db-restore.mjs backups/app-*.db`.
3. File the incident against `docs/security/security-policy.md`'s contact lane with the
   corrupted file preserved (quarantine copy: `cp app.db app.db.quarantined`).
