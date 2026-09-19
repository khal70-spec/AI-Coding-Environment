// Phase 12 (v1.0.x): golden REVIEW workflow — the operator acceptance storyline for
// the v1.0 release lanes over the bridge kernel: project → task → workspace (agent
// side) → tasks.diff (review the patch) → tasks.mergepreview (clean/conflict) →
// signing chain (--dir pipeline: sums → sign → verify → tamper-refusal). All sandboxed
// in tmp fixtures; never touches the repo pin or dist.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  openDatabase, ProjectsDao, TasksDao, RunsDao, WorkspacesDao, AuditDao,
  AgentRunsDao, TestResultsDao, FindingsDao, McpServersDao, SkillsDao,
} from "../../packages/storage/src/index.ts";
import { TaskEngine } from "../../packages/orchestrator/src/index.ts";
import { buildBridge } from "../../packages/ui/src/commands.ts";

const root = join(fileURLToPath(new URL("../..", import.meta.url)), "");

test("golden v1.0 review workflow — diff → merge-preview → signing chain", async () => {
  const work = mkdtempSync(join(tmpdir(), "aice-golden10-"));
  try {
    // fixture repo + agent-side worktree edits
    const repo = join(work, "repo");
    const git = (args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    execFileSync("git", ["init"], { cwd: work, encoding: "utf8" });
    execFileSync("mkdir", ["-p", repo], { cwd: work });
    git(["init"]);
    git(["config", "user.email", "g@g"]);
    git(["config", "user.name", "g"]);
    writeFileSync(join(repo, "service.ts"), "export const service = () => 1;\n");
    git(["add", "."]); git(["commit", "-m", "base"]);
    const baseSha = git(["rev-parse", "HEAD"]).trim();

    // governed core
    const db = openDatabase(join(work, "app.db")).db;
    const s = {
      actor: "golden-TESTONLY",
      projects: new ProjectsDao(db), tasks: new TasksDao(db), runs: new RunsDao(db),
      workspaces: new WorkspacesDao(db), audit: new AuditDao(db), agentRuns: new AgentRunsDao(db),
      testResults: new TestResultsDao(db), findings: new FindingsDao(db),
      mcpServers: new McpServersDao(db), skills: new SkillsDao(db),
    };
    s.engine = new TaskEngine(s);
    const bridge = buildBridge();
    const p = (await bridge.dispatch(s, { command: "projects.create", args: { name: "golden", rootPath: repo } })).data;
    const t = (await bridge.dispatch(s, { command: "tasks.create", args: { projectId: p.id, title: "implement feature X", risk: "medium" } })).data;

    // agent side: task branch (never checked out in the main worktree — git's
    // worktree-add refuses a checked-out branch) + worktree + edits
    git(["branch", `task/${t.id}`]);
    const wt = join(repo, ".aice/worktrees/g");
    execFileSync("mkdir", ["-p", join(repo, ".aice/worktrees")], { cwd: work });
    git(["worktree", "add", ".aice/worktrees/g", `task/${t.id}`]);
    const wtGit = (args) => execFileSync("git", args, { cwd: wt, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    writeFileSync(join(wt, "service.ts"), "export const service = () => 2; // feature X\n");
    writeFileSync(join(wt, "feature.ts"), "export const feature = true;\n");
    wtGit(["add", "."]); wtGit(["commit", "-m", "agent: feature X"]);
    const ws = s.workspaces.create({ projectId: p.id, taskId: t.id, path: wt, branch: `task/${t.id}`, baseSha });

    // REVIEW lane 1: the diff the operator sees (base → task working tree)
    const d = (await bridge.dispatch(s, { command: "tasks.diff", args: { taskId: t.id } })).data;
    assert.match(d.stat, /service\.ts/);
    assert.match(d.stat, /feature\.ts/);
    assert.match(d.patch, /-export const service = \(\) => 1;/);
    assert.match(d.patch, /\+export const service = \(\) => 2;/);

    // REVIEW lane 2: merge preview (clean here: master untouched)
    const mp = (await bridge.dispatch(s, { command: "tasks.mergepreview", args: { taskId: t.id } })).data;
    assert.equal(mp.mergeable, true);
    assert.deepEqual(mp.conflicts, []);
    assert.equal(mp.workspace.id, ws.id);

    // audit trail carries both review actions (content-free)
    const audit = (await bridge.dispatch(s, { command: "audit.list", args: { taskId: t.id } })).data;
    assert.ok(audit.some((e) => e.action === "ui.task.diff"));
    assert.ok(audit.some((e) => e.action === "ui.task.mergepreview"));

    // RELEASE lane: sums → sign → verify → tamper-refusal (fixture dir + tmp pins)
    const dist = join(work, "dist");
    execFileSync("mkdir", [dist]);
    writeFileSync(join(dist, "SHA256SUMS.txt"), `${"ab".repeat(32)}  aice-v1.0.1-test.tar.gz\n`);
    const priv = join(work, "pub-priv.pem");
    const pub = join(work, "pub.pem");
    const runs = (f, args) => spawnSync(process.execPath, [f, ...args], { cwd: root, encoding: "utf8", timeout: 60_000 });
    assert.equal(runs("scripts/release-sign.mjs", ["--genkey", priv, "--pin", pub]).status, 0);
    assert.equal(runs("scripts/release-sign.mjs", ["--key", priv, "--dir", dist]).status, 0);
    assert.equal(runs("scripts/release-verify-sign.mjs", ["--dir", dist, "--require-signature", "--pin", pub]).status, 0);
    writeFileSync(join(dist, "SHA256SUMS.txt"), `${"cd".repeat(32)}  aice-v1.0.1-test.tar.gz\n`);
    assert.equal(runs("scripts/release-verify-sign.mjs", ["--dir", dist, "--require-signature", "--pin", pub]).status, 1);
  } finally { rmSync(work, { recursive: true, force: true }); }
});
