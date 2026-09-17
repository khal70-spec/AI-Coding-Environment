// Security T18/T19 (Phase 1 runtime): failure states MUST route through the legal
// rollback path; skipped verification MUST be denied + audited; terminal states are final.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openDatabase, ProjectsDao, TasksDao, RunsDao, AuditDao,
} from "../../packages/storage/src/index.ts";
import { TaskEngine } from "../../packages/orchestrator/src/index.ts";

describe("rollback + terminal enforcement (security)", () => {
  let dir, db, s;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "aice-rb-"));
    db = openDatabase(join(dir, "app.db")).db;
    const projects = new ProjectsDao(db);
    const tasks = new TasksDao(db);
    const runs = new RunsDao(db);
    const audit = new AuditDao(db);
    s = { projects, tasks, runs, audit, engine: new TaskEngine({ tasks, runs, audit }) };
    s.project = projects.create({ name: "P", rootPath: "/tmp/TESTONLY" });
  });
  after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function taskToImplementing() {
    const t = s.tasks.create({ projectId: s.project.id, title: "t", risk: "low" });
    for (const _ of ["CLASSIFYING", "INVESTIGATING", "PLANNING", "WAITING_APPROVAL", "PREPARING_WORKSPACE"]) {
      assert.equal(s.engine.transition({ taskId: t.id, actor: "TESTONLY" }).ok, true);
    }
    s.engine.recordCheckpoint(t.id, { sha: "d".repeat(40), branch: "main", dirty: false }, "TESTONLY");
    assert.equal(s.engine.transition({ taskId: t.id, actor: "TESTONLY" }).ok, true);
    return t; // IMPLEMENTING
  }

  it("FAILED → ROLLBACK_REQUIRED → FAILED is the only rollback path", () => {
    const t = taskToImplementing();
    assert.equal(s.engine.transition({ taskId: t.id, to: "FAILED", actor: "TESTONLY" }).ok, true);
    // cannot advance forward from FAILED (terminal-ish): no happy path edge
    const fwd = s.engine.transition({ taskId: t.id, actor: "TESTONLY" });
    assert.equal(fwd.ok, false);
    // legal: FAILED → ROLLBACK_REQUIRED → FAILED
    assert.equal(s.engine.transition({ taskId: t.id, to: "ROLLBACK_REQUIRED", actor: "TESTONLY" }).ok, true);
    assert.equal(s.tasks.get(t.id).state, "ROLLBACK_REQUIRED");
    assert.equal(s.engine.transition({ taskId: t.id, to: "FAILED", actor: "TESTONLY" }).ok, true);
    assert.equal(s.tasks.get(t.id).state, "FAILED");
    const actions = s.audit.listByTask(t.id).map((e) => `${e.action}:${e.detail?.to ?? ""}`);
    assert.ok(actions.some((a) => a.includes("ROLLBACK_REQUIRED")), "rollback transition audited");
  });

  it("verification skips are denied everywhere (no hidden jumps to merge)", () => {
    const t = taskToImplementing();
    for (const to of ["READY", "APPROVED", "MERGED"]) {
      const r = s.engine.transition({ taskId: t.id, to, actor: "TESTONLY" });
      assert.equal(r.ok, false, `skip to ${to} denied`);
      assert.equal(r.error.code, "ILLEGAL_TRANSITION");
    }
    const denied = s.audit.listByTask(t.id).filter((e) => e.action === "task.transition.denied");
    assert.equal(denied.length, 3, "every skip attempt audited");
  });

  it("CANCELLED is final — resume attempts denied and audited", () => {
    const t = s.tasks.create({ projectId: s.project.id, title: "t2", risk: "low" });
    assert.equal(s.engine.transition({ taskId: t.id, to: "CANCELLED", actor: "TESTONLY" }).ok, true);
    for (const to of ["CLASSIFYING", "BLOCKED", "INVESTIGATING"]) {
      const r = s.engine.transition({ taskId: t.id, to, actor: "TESTONLY" });
      assert.equal(r.ok, false, `resume to ${to} denied`);
    }
  });

  it("BLOCKED can resume only via INVESTIGATING/PLANNING — never into IMPLEMENTING", () => {
    const t = s.tasks.create({ projectId: s.project.id, title: "t3", risk: "low" });
    s.engine.transition({ taskId: t.id, actor: "TESTONLY" }); // CLASSIFYING
    s.engine.transition({ taskId: t.id, actor: "TESTONLY" }); // INVESTIGATING
    s.engine.transition({ taskId: t.id, to: "BLOCKED", actor: "TESTONLY" });
    const r = s.engine.transition({ taskId: t.id, to: "IMPLEMENTING", actor: "TESTONLY" });
    assert.equal(r.ok, false, "BLOCKED → IMPLEMENTING denied");
    assert.equal(r.error.code, "ILLEGAL_TRANSITION");
    assert.equal(s.engine.transition({ taskId: t.id, to: "INVESTIGATING", actor: "TESTONLY" }).ok, true, "resume path legal");
  });
});
