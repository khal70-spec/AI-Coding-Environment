// Unit: typed DAOs on a real (temp) SQLite DB — CRUD, scoping, append-only audit.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openDatabase, ProjectsDao, TasksDao, RunsDao, WorkspacesDao, AuditDao,
} from "../../../packages/storage/src/index.ts";

describe("storage DAOs", () => {
  let dir = "";
  let db;
  let daos;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "aice-dao-"));
    const opened = openDatabase(join(dir, "app.db"));
    db = opened.db;
    daos = {
      projects: new ProjectsDao(db),
      tasks: new TasksDao(db),
      runs: new RunsDao(db),
      workspaces: new WorkspacesDao(db),
      audit: new AuditDao(db),
    };
  });
  after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("projects: create/get/list/archive round-trip", () => {
    const p = daos.projects.create({ name: "TESTONLY", rootPath: "/tmp/TESTONLY", classification: "confidential" });
    assert.equal(daos.projects.get(p.id).classification, "confidential");
    assert.equal(daos.projects.list().length, 1);
    daos.projects.archive(p.id);
    assert.equal(daos.projects.list().length, 0);
    assert.equal(daos.projects.list(true).length, 1);
  });

  it("tasks: FK enforced, state transitions persist with updated_at", () => {
    const p = daos.projects.create({ name: "P2", rootPath: "/tmp/TESTONLY2" });
    assert.throws(() => daos.tasks.create({ projectId: "missing", title: "x" }), /FOREIGN KEY|constraint/i);
    const t = daos.tasks.create({ projectId: p.id, title: "TESTONLY task", risk: "high" });
    assert.equal(t.state, "CREATED");
    daos.tasks.setState(t.id, "CLASSIFYING");
    assert.equal(daos.tasks.get(t.id).state, "CLASSIFYING");
    daos.tasks.setState(t.id, "INVESTIGATING");
    assert.ok(daos.tasks.get(t.id).updatedAt >= t.updatedAt);
  });

  it("tasks: listByProject is project-scoped (T20)", () => {
    const a = daos.projects.create({ name: "A", rootPath: "/tmp/TESTONLY-a" });
    const b = daos.projects.create({ name: "B", rootPath: "/tmp/TESTONLY-b" });
    daos.tasks.create({ projectId: a.id, title: "A task" });
    daos.tasks.create({ projectId: b.id, title: "B task" });
    assert.equal(daos.tasks.listByProject(a.id).every((t) => t.projectId === a.id), true);
    assert.equal(daos.tasks.listByProject(a.id).length, 1);
  });

  it("runs + fix-loop counter", () => {
    const p = daos.projects.create({ name: "R", rootPath: "/tmp/TESTONLY-r" });
    const t = daos.tasks.create({ projectId: p.id, title: "run task" });
    daos.runs.record({ taskId: t.id, agent: "TESTONLY", fromState: "CREATED", toState: "CLASSIFYING" });
    daos.runs.record({ taskId: t.id, agent: "TESTONLY", fromState: "FIXING", toState: "IMPLEMENTING" });
    assert.equal(daos.runs.listByTask(t.id).length, 2);
    assert.equal(daos.tasks.countFixLoops(t.id), 1);
  });

  it("audit: append-only — no update/delete methods shipped, no mutation SQL in source", () => {
    assert.equal(typeof daos.audit.update, "undefined");
    assert.equal(typeof daos.audit.delete, "undefined");
    assert.equal(typeof daos.audit.remove, "undefined");
    const src = readFileSync(new URL("../../../packages/storage/src/dao.ts", import.meta.url), "utf8");
    assert.equal(/UPDATE\s+audit_events/i.test(src), false, "no UPDATE against audit_events");
    assert.equal(/DELETE\s+FROM\s+audit_events/i.test(src), false, "no DELETE against audit_events");
    const p = daos.projects.create({ name: "AU", rootPath: "/tmp/TESTONLY-au" });
    const t = daos.tasks.create({ projectId: p.id, title: "audited" });
    const id = daos.audit.append({ actor: "TESTONLY", action: "x", taskId: t.id, projectId: p.id, detail: { k: 1 } });
    const events = daos.audit.listByTask(t.id);
    assert.equal(events.length, 1);
    assert.equal(events[0].id, id);
    assert.deepEqual(events[0].detail, { k: 1 });
    assert.equal(daos.audit.latestByTaskAction(t.id, "x")?.id, id);
  });

  it("workspaces: create/list/setState scoped by project", () => {
    const p = daos.projects.create({ name: "W", rootPath: "/tmp/TESTONLY-w" });
    const t = daos.tasks.create({ projectId: p.id, title: "ws task" });
    const w = daos.workspaces.create({ projectId: p.id, taskId: t.id, path: "/tmp/TESTONLY-wt", branch: "agent/x", baseSha: "abc" });
    assert.equal(daos.workspaces.listByProject(p.id).length, 1);
    daos.workspaces.setState(w.id, "removed");
    assert.equal(daos.workspaces.get(w.id).state, "removed");
  });
});
