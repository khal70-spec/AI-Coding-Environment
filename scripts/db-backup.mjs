#!/usr/bin/env node
// db-backup (P9.2): crash-safe online backup of the governed SQLite db.
// Mechanism: WAL checkpoint (TRUNCATE) → copy to tempfile → rename (atomic replace).
// Then verify: open the copy, integrity_check, read migration table. Verbatim evidence
// printed; any failure exits 1 (never a silently-corrupt backup on disk).
// Usage: DB_PATH=./.local/app.db node scripts/db-backup.mjs [--out DIR]
import { mkdirSync, copyFileSync, renameSync, existsSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dbPath = resolve(process.env.DB_PATH ?? join(root, ".local/app.db"));
const outIdx = process.argv.indexOf("--out");
const outDir = resolve(outIdx > 0 ? process.argv[outIdx + 1] : join(dirname(dbPath), "backups"));

if (!existsSync(dbPath)) {
  console.error(`db-backup — no database at ${dbPath} (nothing to back up)`);
  process.exit(1);
}
const { DatabaseSync } = await import("node:sqlite");
mkdirSync(outDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const finalName = join(outDir, `app-${stamp}.db`);
const tmpName = join(outDir, `app-${stamp}.${randomUUID()}.tmp`);

// 1) checkpoint the WAL so the main file holds everything committed
const src = new DatabaseSync(dbPath);
try {
  const ck = src.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  if (Number(ck?.busy ?? 0) !== 0) {
    console.error(`db-backup — WAL busy (writers active). Refusing a racy backup.`);
    process.exit(1);
  }
  const jm = src.prepare("PRAGMA journal_mode").get()?.journal_mode;
  console.log(`db-backup — source: journal_mode=${String(jm)} (WAL expected)`);
} finally {
  src.close();
}

// 2) copy → temp → verify → atomic rename
copyFileSync(dbPath, tmpName);
const verify = new DatabaseSync(tmpName);
try {
  const ic = verify.prepare("PRAGMA integrity_check").get()?.integrity_check;
  const fk = verify.prepare("PRAGMA foreign_key_check").all();
  if (ic !== "ok" || fk.length > 0) {
    console.error(`db-backup — copy FAILED verification (integrity=${String(ic)}, fk_violations=${fk.length})`);
    unlinkSync(tmpName);
    process.exit(1);
  }
  const mig = verify.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()?.v;
  const rows = verify
    .prepare("SELECT (SELECT COUNT(*) FROM tasks) AS tasks, (SELECT COUNT(*) FROM projects) AS projects, (SELECT COUNT(*) FROM audit_events) AS audit")
    .get();
  console.log(`db-backup — verified: integrity=ok, migrations=v${Number(mig)}, rows: projects=${rows.projects} tasks=${rows.tasks} audit=${rows.audit}`);
} finally {
  verify.close();
}
renameSync(tmpName, finalName);
console.log(`db-backup — OK → ${finalName}`);
