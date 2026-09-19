// Database opening — the app boot path (Plan §30, ADR-008/009).
// Opens (or creates) the SQLite file, pins foreign keys on, applies pending migrations
// via the SHARED runner. WAL mode is set by migration 001 itself.
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applyMigrations, defaultMigrationsDir } from "./migrate.ts";
import type { MigrationReport } from "./migrate.ts";

export interface OpenedDatabase {
  readonly db: DatabaseSync;
  readonly path: string;
  readonly migrations: MigrationReport;
}

/** Open the app database, migrating forward as needed. Never throws on re-run. */
export function openDatabase(dbPath: string): OpenedDatabase {
  const abs = resolve(dbPath);
  mkdirSync(dirname(abs), { recursive: true });
  const db = new DatabaseSync(abs);
  db.exec("PRAGMA foreign_keys = ON;");
  const migrations = applyMigrations(db, defaultMigrationsDir());
  return { db, path: abs, migrations };
}
