// db-migrate.mjs — applies SQL migrations in packages/storage/migrations/*.sql to a
// local SQLite database. Zero-dependency: uses the built-in node:sqlite driver
// (Node >= 22.18, see package.json engines). Phase 1 may swap the driver per ADR-008
// (better-sqlite3 vs node:sqlite build-matrix check) — migration SQL stays
// driver-neutral.
//
// Idempotent: each migration records its version in schema_migrations; already-applied
// versions are skipped, so re-running is always safe.
//
// Usage: DB_PATH=./.local/app.db node scripts/db-migrate.mjs
import { readdirSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "packages/storage/migrations");
const dbPath = process.env.DB_PATH ?? join(root, ".local/app.db");

let DatabaseSync;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  console.error(
    "db:migrate — node:sqlite unavailable. Requires Node >= 22.18 (see package.json engines).",
  );
  process.exit(1);
}

mkdirSync(dirname(dbPath), { recursive: true });
const files = existsSync(dir)
  ? readdirSync(dir)
      .filter((f) => /^\d+_.*\.sql$/.test(f))
      .sort()
  : [];
if (files.length === 0) {
  console.log(`db:migrate — no migrations found in ${dir}. Nothing to do.`);
  process.exit(0);
}

const db = new DatabaseSync(dbPath);

// Tracking table exists from migration 001 onward; create it up front (same DDL) so the
// applied-version check works on fresh and existing databases alike.
db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
  version   INTEGER PRIMARY KEY,
  name      TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);`);

const applied = new Set(
  db
    .prepare("SELECT version FROM schema_migrations")
    .all()
    .map((row) => Number(row.version)),
);

let appliedCount = 0;
let skippedCount = 0;
for (const file of files) {
  const version = Number(file.split("_")[0]);
  if (applied.has(version)) {
    console.log(`db:migrate — skipping ${file} (version ${version} already applied)`);
    skippedCount++;
    continue;
  }
  const sql = readFileSync(join(dir, file), "utf8");
  console.log(`db:migrate — applying ${file} (version ${version}) → ${dbPath}`);
  // PRAGMA directives (e.g. journal_mode) cannot change inside a transaction — run them
  // first, then apply the rest atomically.
  const pragmaLines = [];
  const bodyLines = [];
  for (const line of sql.split("\n")) {
    (line.trimStart().toUpperCase().startsWith("PRAGMA") ? pragmaLines : bodyLines).push(line);
  }
  for (const pragma of pragmaLines) {
    if (pragma.trim() !== "") db.exec(pragma);
  }
  db.exec("BEGIN");
  try {
    db.exec(bodyLines.join("\n"));
    // Self-recording is idempotent (INSERT OR IGNORE in the SQL); this is the belt to
    // that suspenders for any future migration that forgets to record itself.
    db.prepare("INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)").run(
      version,
      file.replace(/\.sql$/, ""),
    );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    console.error(`db:migrate — FAILED applying ${file}: ${err.message}`);
    console.error("db:migrate — rolled back. Fix the migration and re-run; applied versions are resumable.");
    process.exit(1);
  }
  appliedCount++;
}
db.close();
console.log(
  `db:migrate — done (${appliedCount} applied, ${skippedCount} skipped, ${files.length} total).`,
);
