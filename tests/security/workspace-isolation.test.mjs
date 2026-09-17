// Security T9/T19 (Phase 1 runtime): workspace preparation MUST stay inside the
// project's .aice/worktrees jail; hostile ids/paths MUST fail closed (task BLOCKED
// + audit), and destructive argv must never execute during preparation/removal.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openDatabase, ProjectsDao, TasksDao, RunsDao, WorkspacesDao, AuditDao,
  TestResultsDao,
  FindingsDao,
} from "../../packages/storage/src/index.ts";
import { TaskEngine, WorkspaceService } from "../../packages/orchestrator/src/index.ts";
import { GitRunner, GitSafetyError } from "../../packages/git/src/runner.ts";

function initRepo(dir) {
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "testonly@example.invalid"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "TESTONLY"], { cwd: dir });
  writeFileSync(join(dir, "f.txt"), "TESTONLY\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "TESTONLY"], { cwd: dir });
}

describe("workspace isolation (security)", () => {
  let dir, repo, db, s;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "aice-wsiso-"));
    repo = join(dir, "repo");
    execFileSync("mkdir", ["-p", repo]);
    initRepo(repo);
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

  it("hostile task ids cannot escape the worktree jail", () => {
    const p = s.projects.create({ name: "P", rootPath: repo });
    const evil = s.tasks.create({ projectId: p.id, title: "t", risk: "low", id: "../../../../tmp/aice-escape-attempt" });
    // low-risk → guards pass; id flows into the worktree path builder
    const r = s.wservice.prepare(evil.id, "TESTONLY");
    assert.ok(r.ok, "preparation succeeds (sanitized) instead of escaping");
    assert.ok(r.value.path.startsWith(join(dir, "repo") + "/"), r.value.path);
    assert.ok(r.value.path.includes(".aice/worktrees/"), "jailed path");
    assert.equal(existsSync("/tmp/aice-escape-attempt"), false, "no escape artifact at /tmp");
    // cleanup
    s.wservice.remove(r.value.id, "TESTONLY");
  });

  it("direct worktreeAdd outside the root is refused before spawn", () => {
    const runner = new GitRunner(repo);
    const sha = runner.checkpoint().sha;
    const target = join(dir, "outside-wt");
    assert.throws(() => runner.worktreeAdd(target, sha), (e) => e instanceof GitSafetyError && e.code === "PATH_ESCAPE");
    assert.equal(existsSync(target), false, "nothing created outside the root");
  });

  it("symlinked worktree parent cannot redirect outside", () => {
    const runner = new GitRunner(repo);
    const sha = runner.checkpoint().sha;
    // .aice/worktrees exists as a symlink pointing outside
    rmSync(join(repo, ".aice", "worktrees"), { recursive: true, force: true });
    execFileSync("mkdir", ["-p", join(repo, ".aice")]);
    symlinkSync(dir, join(repo, ".aice", "worktrees"), "dir");
    assert.throws(
      () => runner.worktreeAdd(join(repo, ".aice", "worktrees", "sneaky"), sha),
      (e) => e instanceof GitSafetyError,
      "symlink jailbreak refused",
    );
    assert.equal(existsSync(join(repo, ".aice", "worktrees", "sneaky")), false);
  });

  it("preparation is denied and BLOCKED for non-git project roots (fail closed + audit)", () => {
    const plain = join(dir, "plain");
    execFileSync("mkdir", ["-p", plain]);
    const p = s.projects.create({ name: "PLAIN", rootPath: plain });
    const t = s.tasks.create({ projectId: p.id, title: "x", risk: "low" });
    const r = s.wservice.prepare(t.id, "TESTONLY");
    assert.equal(r.ok, false, "prepare fails closed");
    assert.equal(r.error.code, "WORKSPACE_PREPARE_FAILED");
    assert.equal(s.tasks.get(t.id).state, "BLOCKED", "task blocked, not half-prepared");
    const events = s.audit.listByTask(t.id).map((e) => e.action);
    assert.ok(events.includes("workspace.prepare.failed"), "failure audited");
    assert.ok(events.includes("task.transition"), "BLOCKED transition audited");
  });
});
