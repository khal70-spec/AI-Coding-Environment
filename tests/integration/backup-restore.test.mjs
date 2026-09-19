// Backup/restore + migration lifecycle (P9.2).
//   - backup while data exists → artifact verifies (integrity, migration max, counts)
//   - mutate the live db after backup → restore → pre-mutation truth returns EXACTLY
//   - restore refuses a corrupted candidate (before touching the live db)
//   - migrations are idempotent (second/migrate is a no-op) and additive (script lane)
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = join(ROOT, "apps", "cli", "src", "cli.ts");
const NODE = process.execPath;

function sh(script, args, env, timeout = 60_000) {
  return spawnSync(NODE, [join(ROOT, "scripts", script), ...args], {
    cwd: ROOT, encoding: "utf8", timeout, shell: false, env: { ...process.env, ...env },
  });
}

describe("backup/restore + migration lifecycle", () => {
  let dir = "";
  let db = "";
  let backups = "";
  let projId = "";
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "aice-backup-"));
    db = join(dir, "app.db");
    backups = join(dir, "backups");
    mkdirSync(backups);
    const seed = spawnSync(NODE, ["--no-warnings=Experimental", CLI, "project", "create", "--name", "bak-TESTONLY", "--path", dir, "--json", "--db", db], { encoding: "utf8", cwd: ROOT, shell: false });
    assert.equal(seed.status, 0, seed.stderr);
    projId = JSON.parse(seed.stdout.trim()).id;
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("backup verifies + restore returns pre-mutation truth exactly", { timeout: 120_000 }, () => {
    // seed two tasks → backup A
    for (const t of ["alpha", "beta"]) {
      const r = spawnSync(NODE, ["--no-warnings=Experimental", CLI, "task", "create", "--project", projId, "--title", t, "--json", "--db", db], { encoding: "utf8", cwd: ROOT, shell: false });
      assert.equal(r.status, 0, r.stderr);
    }
    const back = sh("db-backup.mjs", ["--out", backups], { DB_PATH: db });
    assert.equal(back.status, 0, back.stdout + back.stderr);
    assert.match(back.stdout, /verified: integrity=ok/);
    assert.match(back.stdout, /rows: projects=1 tasks=2/);
    const artifacts = readdirSync(backups).filter((f) => f.endsWith(".db"));
    assert.equal(artifacts.length, 1);
    const artifact = join(backups, artifacts[0]);

    // mutate live: add gamma, archive project — restore must UNDO both
    const mk = spawnSync(NODE, ["--no-warnings=Experimental", CLI, "task", "create", "--project", projId, "--title", "gamma", "--json", "--db", db], { encoding: "utf8", cwd: ROOT, shell: false });
    assert.equal(mk.status, 0);
    const arch = spawnSync(NODE, ["--no-warnings=Experimental", CLI, "project", "archive", projId, "--json", "--db", db], { encoding: "utf8", cwd: ROOT, shell: false });
    assert.equal(arch.status, 0);

    const restore = sh("db-restore.mjs", [artifact], { DB_PATH: db });
    assert.equal(restore.status, 0, restore.stdout + restore.stderr);
    assert.match(restore.stdout, /candidate verified/);
    assert.match(restore.stdout, /safety-copied/);

    // truth: alpha + beta present, gamma ABSENT, project un-archived
    const list = spawnSync(NODE, ["--no-warnings=Experimental", CLI, "task", "list", "--json", "--db", db], { encoding: "utf8", cwd: ROOT, shell: false });
    const tasks = JSON.parse(list.stdout);
    const titles = tasks.map((t) => t.title).sort();
    assert.deepEqual(titles, ["alpha", "beta"]);
    const plist = JSON.parse(spawnSync(NODE, ["--no-warnings=Experimental", CLI, "project", "list", "--json", "--db", db], { encoding: "utf8", cwd: ROOT, shell: false }).stdout);
    assert.equal(plist.length, 1, "un-archived project must reappear in the live list");

  });

  it("restore REFUSES a corrupted candidate without touching the live db", { timeout: 60_000 }, async () => {
    // corrupt a backup copy: truncate mid-file (WAL-free truncation guarantees an integrity failure)
    const good = sh("db-backup.mjs", ["--out", backups], { DB_PATH: db });
    assert.equal(good.status, 0);
    const artifacts = readdirSync(backups).filter((f) => f.endsWith(".db")).sort();
    const cand = artifacts[artifacts.length - 1];
    const corrupt = join(backups, "corrupt-TESTONLY.db");
    copyFileSync(join(backups, cand), corrupt);
    const { readFileSync: read } = await import("node:fs");
    const bytes = read(corrupt);
    writeFileSync(corrupt, bytes.subarray(0, Math.floor(bytes.length / 2)));
    const refuse = sh("db-restore.mjs", [corrupt], { DB_PATH: db });
    assert.equal(refuse.status, 1);
    assert.match(refuse.stdout + refuse.stderr, /FAILED integrity|Refusing/);
    // live db untouched: task list still parses
    const list = spawnSync(NODE, ["--no-warnings=Experimental", CLI, "task", "list", "--json", "--db", db], { encoding: "utf8", cwd: ROOT, shell: false });
    assert.equal(list.status, 0);
  });

  it("migrations are idempotent: apply twice → second run applies nothing", { timeout: 60_000 }, () => {
    const first = sh("db-migrate.mjs", [], { DB_PATH: db });
    assert.equal(first.status, 0, first.stderr);
    const second = sh("db-migrate.mjs", [], { DB_PATH: db });
    assert.equal(second.status, 0, second.stderr);
    assert.doesNotMatch(second.stdout, /applied 00[1-9]/);
    assert.match(second.stdout, /skipping 00[1-9]/);
  });

  it("migration-check lane is green on the shipped set (additive-only)", { timeout: 60_000 }, () => {
    const lint = sh("migration-check.mjs", [], {});
    assert.equal(lint.status, 0, lint.stdout + lint.stderr);
    assert.match(lint.stdout, /MIGRATION-CHECK: GREEN/);
  });
});
