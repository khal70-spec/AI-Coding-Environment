// Shared forward-only migration runner — Plan §30, ADR-008/ADR-009.
// Single source used by BOTH the operator script (scripts/db-migrate.mjs) and the app
// boot path (packages/storage/src/database.ts): migration logic exists exactly once.
// Idempotent: schema_migrations is the applied-version ledger; re-runs skip.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Structural subset of node:sqlite DatabaseSync (keeps this module driver-shaped). */
export interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: readonly unknown[]): unknown;
    get(...params: readonly unknown[]): Record<string, unknown> | undefined;
    all(...params: readonly unknown[]): Record<string, unknown>[];
  };
}

export interface MigrationReport {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
  readonly total: number;
}

export class MigrationError extends Error {
  readonly file: string;
  constructor(file: string, cause: unknown) {
    super(`migration ${file} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "MigrationError";
    this.file = file;
  }
}

const TRACKING_DDL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version   INTEGER PRIMARY KEY,
  name      TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);`;

/** packages/storage/migrations relative to this module — the only migrations location. */
export function defaultMigrationsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
}

/** List NNN_*.sql migration files in apply order: [{ version, file }]. */
export function listMigrationFiles(dir: string): readonly { version: number; file: string }[] {
  if (!existsSync(dir)) return Object.freeze([]);
  return Object.freeze(
    readdirSync(dir)
      .filter((f) => /^(\d+)_.*\.sql$/.test(f))
      .sort()
      .map((file) => ({ version: Number(file.split("_")[0]), file })),
  );
}

/**
 * Apply all pending migrations in order. Already-recorded versions are skipped.
 * Each migration runs in a transaction (PRAGMA lines hoisted — journal/synchronous
 * modes cannot change inside one). Throws MigrationError after ROLLBACK on failure.
 */
export function applyMigrations(db: SqliteDb, dir: string): MigrationReport {
  db.exec(TRACKING_DDL);
  const appliedVersions = new Set(
    db
      .prepare("SELECT version FROM schema_migrations")
      .all()
      .map((row) => Number(row["version"])),
  );
  const files = listMigrationFiles(dir);
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const { version, file } of files) {
    if (appliedVersions.has(version)) {
      skipped.push(file);
      continue;
    }
    const sql = readFileSync(join(dir, file), "utf8");
    const pragmaLines: string[] = [];
    const bodyLines: string[] = [];
    for (const line of sql.split("\n")) {
      (line.trimStart().toUpperCase().startsWith("PRAGMA") ? pragmaLines : bodyLines).push(line);
    }
    for (const pragma of pragmaLines) {
      if (pragma.trim() !== "") db.exec(pragma);
    }
    db.exec("BEGIN");
    try {
      db.exec(bodyLines.join("\n"));
      // Belt-and-suspenders: migrations self-record with INSERT OR IGNORE; this covers
      // any future migration that forgets.
      db.prepare("INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)").run(
        version,
        file.replace(/\.sql$/, ""),
      );
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw new MigrationError(file, err);
    }
    applied.push(file);
  }
  return { applied: Object.freeze(applied), skipped: Object.freeze(skipped), total: files.length };
}
