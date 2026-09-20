// Unit: storage inventory + migration mirror discipline (live DDL comparison).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { TABLES, MIGRATIONS, SECRET_REF_COLUMNS } from "../../../packages/storage/src/index.ts";
import {
  applyMigrations,
  defaultMigrationsDir,
} from "../../../packages/storage/src/migrate.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const storageDir = join(root, "packages/storage");

/** Canonicalize DDL for comparison (comments/casing/whitespace/IF NOT EXISTS differ). */
function canonSql(sql) {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/([(),;'"])/g, " $1 ")
    .replace(/if\s+not\s+exists/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function createStatementsOf(sqlText) {
  // canonSql FIRST strips comments — semicolons inside `--` comments must not split.
  return canonSql(sqlText)
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("create"));
}

describe("storage", () => {
  it("schema.sql creates every inventoried table", () => {
    const sql = readFileSync(join(storageDir, "schema.sql"), "utf8");
    for (const t of TABLES) assert.ok(sql.includes(`CREATE TABLE IF NOT EXISTS ${t}`), t);
  });

  it("migrations are ordered and present", () => {
    assert.deepEqual(MIGRATIONS, [
      { version: 1, file: "001_initial.sql" },
      { version: 2, file: "002_provider_config.sql" },
      { version: 3, file: "003_budgets.sql" },
      { version: 4, file: "004_agent_runs.sql" },
      { version: 5, file: "005_skills.sql" },
      { version: 6, file: "006_memory.sql" },
    ]);
  });

  it("every migration self-records idempotently (INSERT OR IGNORE)", () => {
    for (const { file, version } of MIGRATIONS) {
      const mig = readFileSync(join(storageDir, "migrations", file), "utf8");
      assert.match(mig, /INSERT OR IGNORE INTO schema_migrations/, `${file}: re-applying must not fail`);
      assert.match(mig, new RegExp(`VALUES \\(${version},`), `${file}: records its own version`);
    }
  });

  it("schema.sql mirrors the LIVE schema produced by all migrations (no drift)", () => {
    const db = new DatabaseSync(":memory:");
    applyMigrations(db, defaultMigrationsDir());
    const live = db
      .prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((r) => canonSql(String(r.sql)))
      .sort();
    db.close();
    const mirror = createStatementsOf(readFileSync(join(storageDir, "schema.sql"), "utf8")).sort();
    assert.deepEqual(
      [...live].sort(),
      mirror,
      "schema.sql diverged from the migrations; update both together (ADR-008)",
    );
  });

  it("declares only vault-ref columns for credentials", () => {
    assert.deepEqual(SECRET_REF_COLUMNS, [{ table: "provider_credentials", column: "vault_ref" }]);
    const sql = readFileSync(join(storageDir, "schema.sql"), "utf8");
    assert.ok(!/api[_-]?key\s+TEXT/i.test(sql), "no secret-value columns");
  });
});
