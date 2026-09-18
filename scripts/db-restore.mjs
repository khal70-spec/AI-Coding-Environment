#!/usr/bin/env node
// db-restore (P9.2): restore a backup made by db-backup.mjs into DB_PATH, safely.
// Guards: backup file must pass integrity_check + fk_check BEFORE it replaces anything;
// current DB is itself backed up first (restore = replace, never destruct silently);
// post-restore verification: migrations table + integrity + row counts printed verbatim.
// Usage: DB_PATH=./.local/app.db node scripts/db-restore.mjs <backup-file>
import { copyFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dbPath = resolve(process.env.DB_PATH ?? join(root, ".local/app.db"));
const backup = process.argv[2] !== undefined ? resolve(process.argv[2]) : undefined;
if (backup === undefined || !existsSync(backup)) {
  console.error("db-restore — usage: DB_PATH=<target> node scripts/db-restore.mjs <backup-file>");
  process.exit(1);
}
const { DatabaseSync } = await import("node:sqlite");

// 1) the candidate must prove itself BEFORE it becomes authoritative
let cand;
let migV;
let counts;
try {
  cand = new DatabaseSync(backup);
} catch (err) {
  console.error(`db-restore — backup FAILED integrity (cannot open: ${err instanceof Error ? err.message : String(err)}). Refusing to restore.`);
  process.exit(1);
}
try {
  const ic = cand.prepare("PRAGMA integrity_check").get()?.integrity_check;
  const fk = cand.prepare("PRAGMA foreign_key_check").all();
  if (ic !== "ok" || fk.length > 0) {
    console.error(`db-restore — backup FAILED integrity (integrity=${String(ic)}, fk=${fk.length}). Refusing to restore.`);
    process.exit(1);
  }
  migV = Number(cand.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()?.v ?? 0);
  counts = cand
    .prepare("SELECT (SELECT COUNT(*) FROM tasks) AS tasks, (SELECT COUNT(*) FROM projects) AS projects, (SELECT COUNT(*) FROM audit_events) AS audit")
    .get();
  console.log(`db-restore — candidate verified: v${migV}, projects=${counts.projects} tasks=${counts.tasks} audit=${counts.audit}`);
} catch (err) {
  console.error(`db-restore — backup FAILED integrity (${err instanceof Error ? err.message : String(err)}). Refusing to restore.`);
  try { cand.close(); } catch { /* already dead */ }
  process.exit(1);
} finally {
  try { cand.close(); } catch { /* already dead */ }
}

// 2) pre-restore safety copy of the current DB (never destroy state unbacked)
if (existsSync(dbPath)) {
  const safetyDir = join(dirname(dbPath), "backups");
  mkdirSync(safetyDir, { recursive: true });
  const safety = join(safetyDir, `app-prerestore-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
  const cur = new DatabaseSync(dbPath);
  try { cur.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get(); } finally { cur.close(); }
  copyFileSync(dbPath, safety);
  console.log(`db-restore — current db safety-copied → ${safety}`);
}

// 3) atomic replace + reopen-verify
const tmp = join(dirname(dbPath), `restore-${randomUUID()}.tmp`);
copyFileSync(backup, tmp);
renameSync(tmp, dbPath);
const post = new DatabaseSync(dbPath);
try {
  const ic = post.prepare("PRAGMA integrity_check").get()?.integrity_check;
  if (ic !== "ok") {
    console.error("db-restore — CRITICAL: post-restore integrity failed");
    process.exit(1);
  }
  const after = post
    .prepare("SELECT (SELECT COUNT(*) FROM tasks) AS tasks, (SELECT COUNT(*) FROM projects) AS projects")
    .get();
  console.log(`db-restore — OK: v${migV} restored to ${dbPath} (projects=${after.projects} tasks=${after.tasks})`);
} finally {
  post.close();
}
