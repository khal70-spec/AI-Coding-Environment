// Security T20 (Phase 1 runtime): project A's tasks, workspaces, and audit events
// MUST never leak into project B's views or operations.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openDatabase, ProjectsDao, TasksDao, RunsDao, WorkspacesDao, AuditDao,
  TestResultsDao,
  FindingsDao,
} from "../../packages/storage/src/index.ts";
import { TaskEngine, WorkspaceService } from "../../packages/orchestrator/src/index.ts";

function initRepo(dir) {
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "testonly@example.invalid"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "TESTONLY"], { cwd: dir });
  writeFileSync(join(dir, "f.txt"), "TESTONLY\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "TESTONLY"], { cwd: dir });
}

describe("cross-project scoping (T20)", () => {
  let dir, repoA, repoB, db, s;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "aice-scope-"));
    repoA = join(dir, "repoA");
    repoB = join(dir, "repoB");
    execFileSync("mkdir", ["-p", repoA, repoB]);
    initRepo(repoA);
    initRepo(repoB);
    db = openDatabase(join(dir, "app.db")).db;
    const daos = {
      projects: new ProjectsDao(db),
      tasks: new TasksDao(db),
      runs: new RunsDao(db),
      workspaces: new WorkspacesDao(db),
      audit: new AuditDao(db),
      testResults: new TestResultsDao(db),
      findings: new FindingsDao(db),
    };
    const engine = new TaskEngine(daos);
    s = { ...daos, engine, wservice: new WorkspaceService(daos, engine) };
  });
  after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("tasks, audit and workspaces stay inside their project boundary", () => {
    const pA = s.projects.create({ name: "A", rootPath: repoA, classification: "confidential" });
    const pB = s.projects.create({ name: "B", rootPath: repoB, classification: "public" });
    const tA = s.tasks.create({ projectId: pA.id, title: "secret A task" });
    const tB = s.tasks.create({ projectId: pB.id, title: "public B task" });

    // Task listings are strictly scoped
    assert.deepEqual(s.tasks.listByProject(pA.id).map((t) => t.id), [tA.id]);
    assert.deepEqual(s.tasks.listByProject(pB.id).map((t) => t.id), [tB.id]);

    // Workspace for A lands only under A's root; B cannot see it
    s.engine.approve(tA.id, "plan", "human-TESTONLY"); // medium risk needs plan approval
    const wsA = s.wservice.prepare(tA.id, "TESTONLY");
    assert.ok(wsA.ok, `prepare failed unexpectedly: ${wsA.ok ? "" : wsA.error.message}`);
    assert.ok(wsA.value.path.startsWith(repoA), "A workspace inside A root");
    assert.ok(!wsA.value.path.startsWith(repoB), "never inside B root");
    assert.equal(s.workspaces.listByProject(pB.id).length, 0, "B sees no workspaces");

    // Audit: A's events invisible through B's project scope (and vice versa)
    const aEvents = s.audit.listByProject(pA.id);
    const bEvents = s.audit.listByProject(pB.id);
    assert.ok(aEvents.some((e) => e.taskId === tA.id));
    assert.equal(aEvents.filter((e) => e.taskId === tB.id).length, 0, "no B-task events in A scope");
    assert.equal(bEvents.filter((e) => e.taskId === tA.id).length, 0, "no A-task events in B scope");

    // Task-scoped audit reads are direct-addressing only
    assert.equal(s.audit.listByTask(tB.id).filter((e) => e.taskId === tA.id).length, 0);

    s.wservice.remove(wsA.value.id, "TESTONLY");
  });
});
