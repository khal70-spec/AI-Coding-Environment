// Perf budgets (P9.3): mechanical performance floors with evidence printed.
// Budgets are generous (≥4× headroom on this sandbox) — a lane breaches only when
// something structurally wrong happened (an accidental O(n²), an unindexed hot
// path, an undiagnosed wait). Actuals print verbatim for the release evidence.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  openDatabase,
  ProjectsDao,
  TasksDao,
  AuditDao,
} from "../../packages/storage/src/index.ts";
import { startBridge } from "../../apps/desktop/src/server.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = join(ROOT, "apps", "cli", "src", "cli.ts");

const ms = () => Number(process.hrtime.bigint()) / 1_000_000;

function timed(label, fn) {
  const t0 = ms();
  const out = fn();
  const dt = ms() - t0;
  console.log(`#     perf ${label.padEnd(28)} ${dt.toFixed(1)}ms`);
  return { out, dt };
}

describe("perf budgets", () => {
  let dir = "";
  before(() => { dir = mkdtempSync(join(tmpdir(), "aice-perf-")); });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("storage: 1000 audit appends + list complete under budget (indexed path)", { timeout: 120_000 }, () => {
    const db = openDatabase(join(dir, "app.db")).db;
    const projects = new ProjectsDao(db);
    const tasks = new TasksDao(db);
    const audit = new AuditDao(db);
    const p = projects.create({ name: "perf-TESTONLY", rootPath: dir, classification: "internal" });
    const t = tasks.create({ projectId: p.id, title: "perf", risk: "low", classification: "internal" });
    const { dt: dtIns } = timed("1000 audit appends", () => {
      db.exec("BEGIN");
      try {
        for (let i = 0; i < 1000; i++) audit.append({ actor: "perf-TESTONLY", action: "perf.row", target: t.id, projectId: p.id, taskId: t.id });
      } finally {
        db.exec("COMMIT");
      }
    });
    assert.ok(dtIns < 5000, `audit append bulk too slow (${dtIns.toFixed(0)}ms)`);
    const { dt: dtList } = timed("listByTask 1000 rows", () => audit.listByTask(t.id));
    assert.ok(dtList < 1000, `audit list too slow (${dtList.toFixed(0)}ms)`);
    db.close();
  });

  it("bridge dispatch warm-loop: 200 dispatches median budget", { timeout: 60_000 }, async () => {
    const web = join(dir, "web");
    mkdirSync(web);
    writeFileSync(join(web, "index.html"), "<html></html>");
    const handle = await startBridge({ dbPath: join(dir, "app.db"), actor: "perf-TESTONLY", webRoot: web });
    try {
      // JIT warmup
      for (let i = 0; i < 20; i++) {
        await fetch(`http://127.0.0.1:${handle.port}/api/bridge`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: "projects.list" }) });
      }
      const t0 = ms();
      for (let i = 0; i < 200; i++) {
        const res = await fetch(`http://127.0.0.1:${handle.port}/api/bridge`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: "projects.list" }) });
        assert.equal(res.status, 200);
        await res.arrayBuffer();
      }
      const total = ms() - t0;
      console.log(`#     perf bridge dispatch x200            ${total.toFixed(1)}ms (median ${(total / 200).toFixed(2)}ms)`);
      assert.ok(total < 20000, `bridge dispatch too slow (median ${(total / 200).toFixed(2)}ms > 100ms)`);
    } finally {
      handle.close();
    }
  });

  it("CLI cold command wall-clock budgets (doctor + project list on live db)", { timeout: 120_000 }, () => {
    const db = join(dir, "cli.db");
    const boot = spawnSync(process.execPath, ["--no-warnings=Experimental", CLI, "project", "create", "--name", "x", "--path", dir, "--json", "--db", db], { encoding: "utf8", cwd: ROOT, shell: false });
    assert.equal(boot.status, 0, boot.stderr);
    const t1 = ms();
    const doctor = spawnSync(process.execPath, ["--no-warnings=Experimental", CLI, "doctor", "--json", "--db", db], { encoding: "utf8", cwd: ROOT, shell: false });
    const dt1 = ms() - t1;
    assert.equal(doctor.status, 0, doctor.stderr);
    const t2 = ms();
    const list = spawnSync(process.execPath, ["--no-warnings=Experimental", CLI, "project", "list", "--json", "--db", db], { encoding: "utf8", cwd: ROOT, shell: false });
    const dt2 = ms() - t2;
    assert.equal(list.status, 0, list.stderr);
    console.log(`#     perf CLI doctor                      ${dt1.toFixed(0)}ms`);
    console.log(`#     perf CLI project list                ${dt2.toFixed(0)}ms`);
    assert.ok(dt1 < 10000, `doctor too slow (${dt1.toFixed(0)}ms)`);
    assert.ok(dt2 < 10000, `list too slow (${dt2.toFixed(0)}ms)`);
  });
});
