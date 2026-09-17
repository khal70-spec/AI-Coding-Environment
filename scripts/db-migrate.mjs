// db-migrate.mjs — Phase 0 placeholder. Applies SQL migrations in packages/storage/migrations/*.sql
// to a local SQLite file. Requires `sqlite3` CLI for now; a better-sqlite3 driver lands in Phase 1.
// Usage: DB_PATH=./.local/app.db node scripts/db-migrate.mjs
import { readdirSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "packages/storage/migrations");
const dbPath = process.env.DB_PATH ?? join(root, ".local/app.db");

mkdirSync(dirname(dbPath), { recursive: true });
const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".sql")).sort() : [];
if (files.length === 0) {
  console.log("db:migrate — no migrations yet (Phase 1 will add 001_initial.sql). Nothing to do.");
  process.exit(0);
}
for (const f of files) {
  const sql = readFileSync(join(dir, f), "utf8");
  console.log(`db:migrate — applying ${f} → ${dbPath}`);
  execSync(`sqlite3 ${JSON.stringify(dbPath)}`, { input: sql, stdio: ["pipe", "inherit", "inherit"] });
}
console.log("db:migrate — done.");
