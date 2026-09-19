// Unit: git.exec tool — Phase-1 GitRunner guarantees behind the P3 policy funnel (P3.3).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRunner } from "../../../packages/tools/src/runtime.ts";
import { GIT_TOOLS } from "../../../packages/tools/src/git-tools.ts";

function untag(output) {
  const lines = output.split("\n");
  assert.ok(lines[0].startsWith("<<<UNTRUSTED-TOOL-OUTPUT"));
  assert.equal(lines[lines.length - 1], "<<<END-UNTRUSTED-TOOL-OUTPUT>>>");
  return lines.slice(1, -1).join("\n");
}

const GRANT = {
  toolsAllow: ["git.exec"],
  toolsDeny: [],
  fsRead: "workspace",
  fsWrite: "workspace",
  terminal: "approved_commands",
  networkDefault: "deny",
  networkAllow: [],
  maxRisk: "high",
  maxClassification: "confidential",
};
const PCTX = { workspaceLocked: false, providerMaxClassification: "confidential" };

function initRepo() {
  const root = mkdtempSync(join(tmpdir(), "aice-git-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "tester@TESTONLY.invalid"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "aice tester TESTONLY"], { cwd: root, stdio: "ignore" });
  writeFileSync(join(root, "a.txt"), "one\n");
  execFileSync("git", ["add", "a.txt"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: root, stdio: "ignore" });
  return root;
}

function setup({ approved = false, root = initRepo() } = {}) {
  const events = [];
  const runner = new ToolRunner(GIT_TOOLS, (e) => events.push(e));
  const call = (argv) =>
    runner.call(
      { tool: "git.exec", args: { argv }, cwd: root, risk: "low", classification: "public" },
      {
        actor: "agent:tester",
        risk: "low",
        classification: "public",
        grant: GRANT,
        policyCtx: PCTX,
        jailRoot: root,
        ...(approved ? { approved: true } : {}),
      },
    );
  return { root, call, body: (r) => untag(r.output), events };
}

const commitCount = (root) =>
  Number(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: root, encoding: "utf8" }).trim());

describe("git.exec read-only surface", () => {
  it("status (porcelain) runs at low risk", async () => {
    const { call, body } = setup();
    const res = await call(["status", "--porcelain=v1", "-b"]);
    assert.equal(res.ok, true, body(res));
    assert.match(body(res), /## main/);
  });

  it("log shows the initial commit", async () => {
    const { call, body } = setup();
    const res = await call(["log", "--oneline"]);
    assert.equal(res.ok, true);
    assert.match(body(res), /init/);
  });

  it("read ops see working-tree changes", async () => {
    const { root, call, body } = setup();
    writeFileSync(join(root, "untracked.txt"), "new\n");
    const res = await call(["status", "--porcelain=v1"]);
    assert.match(body(res), /\?\? untracked\.txt/);
  });
});

describe("git.exec policy gates", () => {
  it("commit is dangerous → approval gate, no commit created", async () => {
    const { root, call } = setup();
    writeFileSync(join(root, "b.txt"), "two\n");
    const before = commitCount(root);
    const add = await call(["add", "b.txt"]);
    const commit = await call(["commit", "-m", "should-not-happen"]);
    assert.equal(add.code, "APPROVAL_REQUIRED");
    assert.equal(commit.code, "APPROVAL_REQUIRED");
    assert.equal(commitCount(root), before);
  });

  it("same commit flows through after approval evidence (approved:true)", async () => {
    const { root, call, body } = setup();
    writeFileSync(join(root, "b.txt"), "two\n");
    assert.equal((await call(["add", "b.txt"])).code, "APPROVAL_REQUIRED");
    const { call: approvedCall } = setup({ approved: true, root });
    const add = await approvedCall(["add", "b.txt"]);
    const commit = await approvedCall(["commit", "-m", "approved change"]);
    assert.equal(add.ok, true, body(add));
    assert.equal(commit.ok, true, body(commit));
    assert.equal(commitCount(root), 2);
  });

  it("classifier-blocked shapes hard-deny (force push, reset --hard, clean -fd)", async () => {
    const { call } = setup();
    for (const argv of [
      ["push", "origin", "main", "--force"],
      ["reset", "--hard", "HEAD"],
      ["clean", "-fd"],
    ]) {
      const res = await call(argv);
      assert.equal(res.ok, false, argv.join(" "));
      assert.equal(res.code, "POLICY_DENIED", argv.join(" "));
    }
  });

  it("leading 'git' is refused (agents pass subcommands only)", async () => {
    const { call } = setup();
    const res = await call(["git", "status"]);
    assert.equal(res.code, "POLICY_DENIED");
  });

  it("unknown subcommands: gated dangerous, then clean EXECUTION_FAILED when approved", async () => {
    const { call } = setup({ approved: true });
    const res = await call(["frobnicate"]);
    assert.equal(res.ok, false);
    assert.equal(res.code, "EXECUTION_FAILED");
    assert.match(untag(res.output), /not a git command|unknown option/);
  });

  it("non-repo jail root fails cleanly, not by escaping", async () => {
    const plainDir = mkdtempSync(join(tmpdir(), "aice-norepo-"));
    const { call } = setup({ root: plainDir });
    const res = await call(["status"]);
    assert.equal(res.ok, false);
    assert.equal(res.code, "EXECUTION_FAILED");
    assert.match(untag(res.output), /not a git repository/i);
  });
});
