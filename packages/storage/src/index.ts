// @ai-coding-env/storage — Plan §30, ADR-008/ADR-009.
// Tables + migrations (migrations/ is the source of truth, schema.sql its tested mirror),
// shared migration runner, boot-path opener, and typed DAOs (audit is append-only).
export { listMigrationFiles, applyMigrations, defaultMigrationsDir, MigrationError } from "./migrate.ts";
export type { MigrationReport, SqliteDb } from "./migrate.ts";
export { openDatabase } from "./database.ts";
export type { OpenedDatabase } from "./database.ts";
export { ProjectsDao, TasksDao, RunsDao, WorkspacesDao, AuditDao, AgentRunsDao } from "./dao.ts";
export type { AuditAppend, AuditEventRow, AgentRunRow, ProjectRow, RunRow, TaskRow, WorkspaceRow } from "./dao.ts";
export { ProvidersDao, ProviderCredentialsDao, ModelsDao } from "./dao-providers.ts";
export { TestResultsDao, FindingsDao } from "./dao-findings.ts";
export type { FindingRow, FindingSeverity, FindingStatus, TestResultRow } from "./dao-findings.ts";
export { BudgetsDao, BudgetEventsDao } from "./dao-budgets.ts";
export { McpServersDao, PermissionsDao, SkillsDao } from "./dao-mcp.ts";
export type { McpServerRow, PermissionRow, SkillRow } from "./dao-mcp.ts";
export { MemoryEntriesDao, MemoryRetentionDao, MEMORY_SCOPES, DEFAULT_RETENTION } from "./dao-memory.ts";
export type { MemoryEntryRow, MemoryIds, MemoryRetentionRow, MemoryScope } from "./dao-memory.ts";
export type { ProviderRow, CredentialRow, ModelRow, ProviderUpsert, ModelUpsert } from "./dao-providers.ts";
export type {
  BudgetRow, BudgetUpsert, BudgetEventRow, BudgetEventAppend, SpendSums, BudgetScope, BudgetWindow,
} from "./dao-budgets.ts";
export {
  MODEL_STATUSES,
  DEFAULT_MODEL_CONTEXT_WINDOW,
  naturalModelId,
} from "./dao-providers.ts";

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
  "budgets",
  "budget_events",
  "agent_runs",
  "skills",
  "memory_entries",
  "memory_retention",
]);

/** Forward-only migrations, applied in order. */
export const MIGRATIONS: readonly { version: number; file: string }[] = Object.freeze([
  { version: 1, file: "001_initial.sql" },
  { version: 2, file: "002_provider_config.sql" },
  { version: 3, file: "003_budgets.sql" },
  { version: 4, file: "004_agent_runs.sql" },
  { version: 5, file: "005_skills.sql" },
  { version: 6, file: "006_memory.sql" },
]);

/** Tables that must never contain secret values (enforced by DAO review + tests). */
export const NO_SECRETS_TABLES: readonly string[] = TABLES;

/** Columns that may hold only vault REFERENCES (vault://…), never values. */
export const SECRET_REF_COLUMNS: readonly { table: string; column: string }[] = Object.freeze([
  { table: "provider_credentials", column: "vault_ref" },
]);
