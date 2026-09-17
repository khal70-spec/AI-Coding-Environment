// Unit: GitRunner — argv-only execution, pre-spawn destructive guards, redaction.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitRunner, GitSafetyError } from "../../../packages/git/src/runner.ts";

function initRepo(dir) {
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "testonly@example.invalid"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "TESTONLY"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "# TESTONLY fixture\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "TESTONLY initial"], { cwd: dir });
}

describe("GitRunner", () => {
  let dir = "";
  let runner;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "aice-gitr-"));
    initRepo(dir);
    runner = new GitRunner(dir);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("is inside a work tree and checkpoints read-only evidence", () => {
    assert.equal(runner.isInsideWorkTree(), true);
    const cp = runner.checkpoint();
    assert.match(cp.sha, /^[0-9a-f]{40}$/);
    assert.equal(cp.branch, "main");
    assert.equal(cp.dirty, false);
  });

  it("dirty flag flips with untracked changes — and never destroys them", () => {
    writeFileSync(join(dir, "new-file.txt"), "TESTONLY user work\n");
    const cp = runner.checkpoint();
    assert.equal(cp.dirty, true);
    assert.equal(existsSync(join(dir, "new-file.txt")), true, "user change preserved");
  });

  it("rejects non-argv input (raw shell strings never execute)", () => {
    assert.throws(() => runner.run("git status; rm -rf /"), (e) => e instanceof GitSafetyError && e.code === "NOT_ARGV");
  });

  it("rejects non-git argv", () => {
    assert.throws(() => runner.run(["rm", "-rf", "."]), (e) => e.code === "NOT_GIT");
  });

  it("blocks destructive git argv BEFORE spawn (nothing executes)", () => {
    const headBefore = runner.checkpoint().sha;
    for (const argv of [
      ["git", "reset", "--hard", "HEAD~1"],
      ["git", "push", "--force", "origin", "main"],
      ["git", "clean", "-fd"],
      ["git", "branch", "-D", "x"],
    ]) {
      assert.throws(() => runner.run(argv), (e) => e instanceof GitSafetyError && e.code === "BLOCKED_COMMAND");
    }
    assert.equal(runner.checkpoint().sha, headBefore, "HEAD untouched");
    assert.equal(existsSync(join(dir, "new-file.txt")), true, "work untouched");
  });

  it("redacts secret-shaped output before returning", () => {
    execFileSync("git", ["commit", "--allow-empty", "-m", "TOKEN sk-TESTONLY-abcdefghijklmnopqrstuvwx1234 logged"], { cwd: dir });
    const r = runner.run(["git", "log", "-1", "--format=%B"]);
    assert.ok(!r.stdout.includes("sk-TESTONLY"), "secret not present");
    assert.match(r.stdout, /\[REDACTED:/);
    assert.ok(r.redactedKinds.length > 0);
  });

  it("refuses worktree paths escaping the repo root", () => {
    const outside = mkdtempSync(join(tmpdir(), "aice-outside-"));
    try {
      assert.throws(
        () => runner.worktreeAdd(join(outside, "wt"), runner.checkpoint().sha),
        (e) => e.code === "PATH_ESCAPE" || e.code === "EXEC_FAILED" && /escapes/.test(e.message),
      );
      assert.equal(existsSync(join(outside, "wt")), false, "nothing created outside");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("creates and removes a worktree under .aice/worktrees (happy path)", () => {
    const sha = runner.checkpoint().sha;
    const wt = join(dir, ".aice", "worktrees", "unit-test-wt");
    mkdirSync(join(dir, ".aice", "worktrees"), { recursive: true });
    runner.worktreeAdd(wt, sha);
    assert.equal(existsSync(join(wt, "README.md")), true);
    runner.worktreeCheckoutBranch(wt, "agent/unit-test");
    const branches = execFileSync("git", ["-C", wt, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
    assert.equal(branches, "agent/unit-test");
    runner.worktreeRemove(wt);
    assert.equal(existsSync(wt), false);
  });
});
