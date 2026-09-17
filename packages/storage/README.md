# `@ai-coding-env/storage`

SQLite schema + migrations + table inventory (Plan §30, ADR-008).

- **Source of truth**: `migrations/*.sql` (forward-only, applied in version order).
- **`schema.sql`** is the reviewed baseline **mirror** of the migrations — never edit it
  without editing the matching migration. `tests/unit/storage/schema.test.mjs` enforces
  the byte-exact invariant, so the two cannot drift.
- **Apply**: `npm run db:migrate` (idempotent; zero-dep `node:sqlite` runner in
  `scripts/db-migrate.mjs`). Production driver chosen in Phase 1 per ADR-008.
- **Rule**: no secret values in any table — `provider_credentials` holds `vault://`
  references only (`SECRET_REF_COLUMNS`). `audit_events` is append-only.

See package source (`src/`) for the Phase 0 kernel + concept notes in code headers.
Master spec: `AI_Coding_Environment_End_to_End_Plan.md`. Backlog: `docs/backlog/`.
