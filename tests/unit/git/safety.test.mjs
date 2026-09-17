// Unit: git safety builders + guards (no execution in Phase 0).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isProtectedBranch, taskBranchName, cmdStatus, cmdWorktreeAdd,
  isDestructiveGitArgs, mayPushToBranch,
} from "../../../packages/git/src/index.ts";

describe("git safety", () => {
  it("protects main/production branches", () => {
    assert.equal(isProtectedBranch("main"), true);
    assert.equal(isProtectedBranch("production"), true);
    assert.equal(isProtectedBranch("agent/task-1"), false);
    assert.equal(isProtectedBranch("release/2", ["release/*"]), true);
  });

  it("builds argv arrays, never shell strings", () => {
    assert.deepEqual(cmdStatus(), ["git", "status", "--porcelain=v1", "-b"]);
    assert.deepEqual(cmdWorktreeAdd("/tmp/wt", "abc123"), ["git", "worktree", "add", "--detach", "/tmp/wt", "abc123"]);
  });

  it("slugs task branch names safely", () => {
    assert.equal(taskBranchName("TASK-42 Fix login!"), "agent/task-42-fix-login");
    assert.throws(() => taskBranchName("!!!"), /empty branch slug/);
  });

  it("flags destructive git args", () => {
    assert.equal(isDestructiveGitArgs(["git", "push", "--force"]).destructive, true);
    assert.equal(isDestructiveGitArgs(["git", "reset", "--hard"]).destructive, true);
    assert.equal(isDestructiveGitArgs(["git", "status"]).destructive, false);
  });

  it("pushes only to verified+approved task branches", () => {
    assert.equal(mayPushToBranch("agent/x", true, true), true);
    assert.equal(mayPushToBranch("agent/x", false, true), false);
    assert.equal(mayPushToBranch("main", true, true), false);
  });
});
