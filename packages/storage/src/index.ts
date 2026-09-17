// @ai-coding-env/storage — Plan §30, ADR-008/ADR-009.
// Tables + migrations (migrations/ is the source of truth, schema.sql its tested mirror),
// shared migration runner, boot-path opener, and typed DAOs (audit is append-only).
export { listMigrationFiles, applyMigrations, defaultMigrationsDir, MigrationError } from "./migrate.ts";
export type { MigrationReport, SqliteDb } from "./migrate.ts";
export { openDatabase } from "./database.ts";
export type { OpenedDatabase } from "./database.ts";
export { ProjectsDao, TasksDao, RunsDao, WorkspacesDao, AuditDao } from "./dao.ts";
export type { AuditAppend, AuditEventRow, ProjectRow, RunRow, TaskRow, WorkspaceRow } from "./dao.ts";

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
