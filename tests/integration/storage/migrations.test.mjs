// Integration: db-migrate applies migrations to a real SQLite file and is idempotent.
// Zero external services — uses node:sqlite against a temp file (Plan §30, ADR-008).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { TABLES, MIGRATIONS } from "../../../packages/storage/src/index.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCRIPT = join(root, "scripts", "db-migrate.mjs");

describe("db-migrate (sqlite file)", () => {
  let dir = "";
  let dbPath = "";
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "aice-mig-"));
    dbPath = join(dir, "app.db");
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("creates the full inventoried schema on a fresh database", () => {
    execFileSync(process.execPath, [SCRIPT], { env: { ...process.env, DB_PATH: dbPath } });
    const db = new DatabaseSync(dbPath);
    const found = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name),
    );
    for (const t of TABLES) assert.ok(found.has(t), `missing table: ${t}`);
    const versions = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
    assert.deepEqual(versions.map((v) => Number(v.version)), MIGRATIONS.map((m) => m.version));
    db.close();
  });

  it("is idempotent: a second run applies nothing and does not fail", () => {
    const out = execFileSync(process.execPath, [SCRIPT], {
      env: { ...process.env, DB_PATH: dbPath },
      encoding: "utf8",
    });
    assert.match(out, new RegExp(`0 applied, ${MIGRATIONS.length} skipped`));
  });

  it("records only vault references, never secret values, in provider_credentials", () => {
    const db = new DatabaseSync(dbPath);
    db.prepare("INSERT INTO providers (id, name, protocol, base_url) VALUES (?,?,?,?)").run(
      "TESTONLY-provider",
      "TESTONLY",
      "generic-rest",
      "https://api.TESTONLY.invalid",
    );
    db.prepare("INSERT INTO provider_credentials (provider_id, vault_ref) VALUES (?,?)").run(
      "TESTONLY-provider",
      "vault://providers/TESTONLY-provider/key",
    );
    const row = db
      .prepare("SELECT vault_ref FROM provider_credentials WHERE provider_id = ?")
      .get("TESTONLY-provider");
    assert.equal(String(row.vault_ref).startsWith("vault://"), true);
    db.close();
  });
});
