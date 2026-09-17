// Integration: full task lifecycle driven through the real CLI over a real git repo
// and a real SQLite file — Plan §46 (fs/Git/SQLite), §32/§33 (machine + approvals).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "apps/cli/src/cli.ts");

describe("CLI lifecycle (real git + SQLite)", () => {
  let dir = "";
  let repo = "";
  let dbPath = "";
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "aice-life-"));
    repo = join(dir, "repo");
    dbPath = join(dir, "app.db");
    execFileSync("mkdir", ["-p", repo]);
    execFileSync("git", ["init", "-b", "main"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "testonly@example.invalid"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "TESTONLY"], { cwd: repo });
    writeFileSync(join(repo, "README.md"), "# TESTONLY fixture\n");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-m", "TESTONLY initial"], { cwd: repo });
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  function aice(...args) {
    const out = execFileSync(process.execPath, [CLI, ...args, "--db", dbPath], { encoding: "utf8" });
    return out;
  }
  function aiceJson(...args) {
    return JSON.parse(aice(...args, "--json"));
  }
  function aiceFail(...args) {
    try {
      execFileSync(process.execPath, [CLI, ...args, "--db", dbPath], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
      return { code: 0, stderr: "" };
    } catch (e) {
      return { code: e.status, stderr: String(e.stderr) };
    }
  }

  it("runs the offline self-check", () => {
    const out = aice("doctor");
    assert.match(out, /node: .* OK/);
    assert.ok(!out.includes("MISSING"));
  });

  it("drives a low-risk task from CREATED to MERGED with workspace + evidence", () => {
    const project = aiceJson("project", "create", "--name", "TESTONLY", "--path", repo);
    const task = aiceJson("task", "create", "--project", project.id, "--title", "TESTONLY low-risk", "--risk", "low");
    assert.equal(task.state, "CREATED");

    for (const state of ["CLASSIFYING", "INVESTIGATING", "PLANNING", "WAITING_APPROVAL"]) {
      const r = aiceJson("task", "advance", task.id);
      assert.equal(r.to, state, `→ ${state}`);
    }

    // Workspace preparation: gate → checkpoint → real worktree on disk
    const ws = aiceJson("workspace", "prepare", task.id);
    assert.equal(ws.branch.startsWith("agent/"), true);
    assert.match(ws.baseSha, /^[0-9a-f]{40}$/);
    assert.equal(existsSync(ws.path), true, "worktree exists on disk");
    assert.ok(ws.path.includes(".aice/worktrees/"), "isolated location");
    assert.equal(existsSync(join(ws.path, "README.md")), true, "fixture content present");

    // Fail-closed proof: IMPLEMENTING before workspace is fine now (checkpoint recorded)
    for (const state of ["IMPLEMENTING", "TESTING", "SECURITY_REVIEW", "AI_REVIEW", "VERIFYING", "READY"]) {
      const r = aiceJson("task", "advance", task.id);
      assert.equal(r.to, state, `→ ${state}`);
    }

    // MERGED denied without verify + review evidence
    aiceJson("task", "advance", task.id); // → APPROVED
    const denied = aiceFail("task", "advance", task.id);
    assert.equal(denied.code, 1);
    assert.match(denied.stderr, /VERIFY_REQUIRED|INDEPENDENT_REVIEW_REQUIRED/);

    aiceJson("verify", task.id, "--tests", "green", "--scans", "green");
    aiceJson("review", task.id, "--by", "code-reviewer");
    const merged = aiceJson("task", "advance", task.id);
    assert.equal(merged.to, "MERGED");

    const show = aiceJson("task", "show", task.id);
    assert.equal(show.task.state, "MERGED");
    const actions = show.audit.map((a) => a.action);
    for (const needed of ["task.create", "task.transition", "workspace.prepare", "checkpoint", "verify", "review"]) {
      assert.ok(actions.includes(needed), `task audit includes ${needed}`);
    }
    assert.ok(actions.includes("task.transition.denied"), "denied merge attempt audited");
    // project.create lives in PROJECT scope (no task_id) — verified through audit --project
    const projectEvents = aiceJson("audit", "--project", project.id);
    assert.ok(projectEvents.some((e) => e.action === "project.create"), "project audit includes project.create");

    // Housekeeping: removal of the worktree via guarded argv
    aiceJson("workspace", "remove", ws.id);
    assert.equal(existsSync(ws.path), false, "worktree removed from disk");
  });

  it("high-risk task: PREPARING_WORKSPACE denied until plan approval (Plan §33)", () => {
    const project = aiceJson("project", "list", "--json");
    const task = aiceJson("task", "create", "--project", project[0].id, "--title", "TESTONLY high-risk", "--risk", "high");
    for (let i = 0; i < 4; i++) aiceJson("task", "advance", task.id);
    const denied = aiceFail("task", "advance", task.id);
    assert.equal(denied.code, 1);
    assert.match(denied.stderr, /APPROVAL_REQUIRED/);
    const show1 = aiceJson("task", "show", task.id);
    assert.equal(show1.task.state, "WAITING_APPROVAL", "state unchanged on deny");
    aiceJson("approve", "plan", task.id, "--by", "human-TESTONLY");
    const okR = aiceJson("task", "advance", task.id);
    assert.equal(okR.to, "PREPARING_WORKSPACE");
    const deniedEvents = aiceJson("audit", "--task", task.id).filter((e) => e.action === "task.transition.denied");
    assert.equal(deniedEvents.length, 1, "denial audited exactly once");
  });
});
