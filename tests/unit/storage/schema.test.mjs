// Unit: storage inventory sanity (live-DB assertions arrive with Phase 1 driver).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TABLES, MIGRATIONS, SECRET_REF_COLUMNS } from "../../../packages/storage/src/index.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("storage", () => {
  it("schema.sql creates every inventoried table", () => {
    const sql = readFileSync(join(root, "packages/storage/schema.sql"), "utf8");
    for (const t of TABLES) assert.ok(sql.includes(`CREATE TABLE IF NOT EXISTS ${t}`), t);
  });

  it("migrations are ordered and present", () => {
    assert.deepEqual(MIGRATIONS, [{ version: 1, file: "001_initial.sql" }]);
    const mig = readFileSync(join(root, "packages/storage/migrations/001_initial.sql"), "utf8");
    assert.ok(mig.includes("schema_migrations"));
  });

  it("declares only vault-ref columns for credentials", () => {
    assert.deepEqual(SECRET_REF_COLUMNS, [{ table: "provider_credentials", column: "vault_ref" }]);
    const sql = readFileSync(join(root, "packages/storage/schema.sql"), "utf8");
    assert.ok(!/api[_-]?key\s+TEXT/i.test(sql), "no secret-value columns");
  });
});
