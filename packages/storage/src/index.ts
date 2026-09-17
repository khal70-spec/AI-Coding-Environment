// @ai-coding-env/storage — Plan §30, ADR-008.
// Phase 0: table inventory + migration manifest (apply via scripts/db-migrate.mjs).
// Typed DAOs + driver selection land in Phase 1.

/** Canonical table inventory — integration tests assert the live DB matches this. */
export const TABLES: readonly string[] = Object.freeze([
  "schema_migrations",
  "projects",
  "workspaces",
  "conversations",
  "tasks",
  "runs",
  "agents",
  "providers",
  "provider_credentials",
  "models",
  "mcp_servers",
  "permissions",
  "audit_events",
  "test_results",
  "security_findings",
]);

/** Forward-only migrations, applied in order. */
export const MIGRATIONS: readonly { version: number; file: string }[] = Object.freeze([
  { version: 1, file: "001_initial.sql" },
]);

/** Tables that must never contain secret values (enforced by DAO review + tests). */
export const NO_SECRETS_TABLES: readonly string[] = TABLES;

/** Columns that may hold only vault REFERENCES (vault://…), never values. */
export const SECRET_REF_COLUMNS: readonly { table: string; column: string }[] = Object.freeze([
  { table: "provider_credentials", column: "vault_ref" },
]);
