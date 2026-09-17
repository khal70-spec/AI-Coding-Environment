# `@ai-coding-env/storage`

SQLite persistence for all local state (Plan §30, ADR-008/ADR-009).

- **Source of truth**: `migrations/*.sql` (forward-only, applied in version order).
- **`schema.sql`** is the reviewed baseline **mirror** of the migrations — never edit it
  without editing the matching migration. `tests/unit/storage/schema.test.mjs` enforces
  the byte-exact invariant, so the two cannot drift.
- **Driver**: built-in `node:sqlite` (ADR-009) behind the `SqliteDb` structural
  interface — a later swap touches one module, never call sites.
- **Migration logic lives once** in `src/migrate.ts`, shared by the operator script
  (`scripts/db-migrate.mjs`) and the app boot path (`src/database.ts` "migrate on open").
- **Typed DAOs** (`src/dao.ts`): projects, tasks, runs, workspaces, audit.
  Parameterized statements only; project-scoped list queries (T20);
  `provider_credentials` holds `vault://` refs only (T5).
- **Audit is append-only by construction**: `AuditDao` ships no update/delete and no
  mutation SQL against `audit_events` exists — proven by a source-scan test.
- **Apply**: `npm run db:migrate` (idempotent) or any CLI command (migrate-on-open).
