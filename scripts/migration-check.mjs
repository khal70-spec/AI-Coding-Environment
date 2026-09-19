#!/usr/bin/env node
// migration-check (P9.2): additive-only migration policy enforcer (repo mandate).
// A shipped migration may create new objects or ADD columns; it may never reshape
// or destroy existing data carriers. Forbidden, fail-closed:
//   M1 DROP TABLE / DROP COLUMN / RENAME (destroy or rename data carriers)
//   M2 ALTER TABLE ... DROP / RENAME
//   M3 UPDATE / DELETE / INSERT inside migrations targeting app tables (data mutation
//      must happen in app code with audit, not DDL)
//   M4 non-idempotent-newer-version reuse of an older migration FILENAME (versions are
//      append-only history)
// Also asserts the on-disk set is well-formed: NNN_name.sql, strictly increasing,
// no duplicate versions, no gaps beyond 9.
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migDir = join(root, "packages/storage/migrations");
const violations = [];

const files = readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort();
const seen = new Map();
const parsed = [];
for (const f of files) {
  const m = /^(\d{3})_([a-z0-9_]+)\.sql$/.exec(f);
  if (m === null) {
    violations.push(`M4 non-canonical migration filename: ${f}`);
    continue;
  }
  const version = Number(m[1]);
  if (seen.has(version)) violations.push(`M4 duplicate migration version ${version}: ${seen.get(version)} + ${f}`);
  seen.set(version, f);
  parsed.push({ version, file: f, sql: readFileSync(join(migDir, f), "utf8") });
}

parsed.sort((a, b) => a.version - b.version);
let prev = 0;
for (const { version, file, sql } of parsed) {
  if (version - prev > 10) violations.push(`M4 migration version gap too large: ${prev} → ${version} (${file})`);
  prev = version;
  // M1/M2/M3 on statement level (comment-stripped)
  const code = sql.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
  if (/\bDROP\s+(TABLE|COLUMN)\b/i.test(code)) violations.push(`M1 ${file}: DROP forbidden (additive-only)`);
  if (/\bRENAME\b/i.test(code)) violations.push(`M1 ${file}: RENAME forbidden`);
  if (/\bALTER\s+TABLE[\s\S]*?\bDROP\b/i.test(code)) violations.push(`M2 ${file}: ALTER ... DROP forbidden`);
  if (/^\s*(UPDATE|DELETE\s+FROM|INSERT\s+INTO)\s+/im.test(code)) {
    violations.push(`M3 ${file}: data mutation inside migration forbidden (audited app lanes own DML)`);
  }
}

console.log(`# migration-check — ${parsed.length} migrations scanned (additive-only policy)`);
if (violations.length > 0) {
  for (const v of violations) console.log(`VIOLATION  ${v}`);
  console.error(`MIGRATION-CHECK: FAIL (${violations.length} violation(s))`);
  process.exit(1);
}
console.log(`MIGRATION-CHECK: GREEN (${parsed.length} migrations, additive-only, well-formed)`);
