// db-migrate.mjs — operator script: applies packages/storage/migrations to a SQLite
// file. Thin wrapper over the SHARED runner in packages/storage/src/migrate.ts (the
// same code the app boot path calls — migration logic lives exactly once).
// Zero external deps (node:sqlite, Node >= 22.18). Idempotent: re-runs skip.
// Usage: DB_PATH=./.local/app.db node scripts/db-migrate.mjs
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dbPath = resolve(process.env.DB_PATH ?? join(root, ".local/app.db"));

let DatabaseSync;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  console.error("db:migrate — node:sqlite unavailable. Requires Node >= 22.18 (see package.json engines).");
  process.exit(1);
}
const { applyMigrations, defaultMigrationsDir, MigrationError } = await import(
  join(root, "packages/storage/src/migrate.ts")
);

mkdirSync(dirname(dbPath), { recursive: true });
const db = new DatabaseSync(dbPath);
let report;
try {
  report = applyMigrations(db, defaultMigrationsDir());
} catch (err) {
  if (err instanceof MigrationError) {
    console.error(`db:migrate — FAILED: ${err.message}`);
    console.error("db:migrate — rolled back. Fix the migration and re-run; applied versions are resumable.");
    process.exit(1);
  }
  throw err;
} finally {
  db.close();
}
for (const f of report.skipped) console.log(`db:migrate — skipping ${f} (already applied)`);
for (const f of report.applied) console.log(`db:migrate — applied ${f} → ${dbPath}`);
console.log(
  `db:migrate — done (${report.applied.length} applied, ${report.skipped.length} skipped, ${report.total} total).`,
);
