// Unit: UI bridge kernel (P7.1) — allowlist, arg pinning, hostile/fuzz matrix,
// service scoping proof (T20 cross-project access structurally refused).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openDatabase,
  ProjectsDao,
  TasksDao,
  RunsDao,
  WorkspacesDao,
  AuditDao,
  AgentRunsDao,
  TestResultsDao,
  FindingsDao,
  McpServersDao,
  SkillsDao,
} from "../../../packages/storage/src/index.ts";
import { TaskEngine } from "../../../packages/orchestrator/src/index.ts";
import { BridgeRegistry, bridgeFingerprint, BRIDGE_VERSION } from "../../../packages/ui/src/bridge.ts";
import { buildBridge } from "../../../packages/ui/src/commands.ts";
import { execFileSync } from "node:child_process";

function mkServices(db) {
  const s = {
    actor: "ui-TESTONLY",
    projects: new ProjectsDao(db),
    tasks: new TasksDao(db),
    runs: new RunsDao(db),
    workspaces: new WorkspacesDao(db),
    audit: new AuditDao(db),
    agentRuns: new AgentRunsDao(db),
    testResults: new TestResultsDao(db),
    findings: new FindingsDao(db),
    mcpServers: new McpServersDao(db),
    skills: new SkillsDao(db),
  };
  s.engine = new TaskEngine({ tasks: s.tasks, runs: s.runs, audit: s.audit, testResults: s.testResults, findings: s.findings });
  return s;
}

describe("BridgeRegistry kernel", () => {
  it("allowlist: unknown commands are denied structurally (never dispatch)", async () => {
    const reg = new BridgeRegistry([
      { id: "ping", args: {}, run: () => "pong" },
    ]);
    assert.deepEqual(reg.ids(), ["ping"]);
    const reply = await reg.dispatch(null, { command: "eval", args: { src: "process.exit(1)" } });
    assert.equal(reply.ok, false);
    assert.equal(reply.code, "UNKNOWN_COMMAND");
    assert.match(reply.message, /eval/);
    const ok = await reg.dispatch(null, { command: "ping" });
    assert.deepEqual(ok, { ok: true, data: "pong" });
  });

  it("duplicate command ids refuse registration (no last-write-wins)", () => {
    assert.throws(
      () => new BridgeRegistry([{ id: "x", args: {}, run: () => 1 }, { id: "x", args: {}, run: () => 2 }]),
      /duplicate/,
    );
  });

  it("pinned args schema: fuzz matrix yields BAD_ARGS, never crashes", async () => {
    const reg = new BridgeRegistry([
      { id: "get", args: { id: { type: "string", required: true, max: 8, pattern: /^[a-z]+$/ }, n: { type: "integer", max: 100 }, flag: { type: "boolean" }, mode: { type: "string", enum: ["a", "b"] } }, run: (_s, a) => a.id },
    ]);
    const bad = [
      ["array args", { command: "get", args: [1, 2] }],
      ["string args", { command: "get", args: "ID" }],
      ["missing required", { command: "get", args: {} }],
      ["wrong type number", { command: "get", args: { id: 1 } }],
      ["wrong type bool", { command: "get", args: { id: "ok", flag: 1 } }],
      ["overlong string", { command: "get", args: { id: "w".repeat(9) } }],
      ["pattern fail", { command: "get", args: { id: "ABC" } }],
      ["float not integer", { command: "get", args: { id: "ok", n: 1.5 } }],
      ["integer overflow", { command: "get", args: { id: "ok", n: 101 } }],
      ["enum fail", { command: "get", args: { id: "ok", mode: "c" } }],
      ["unexpected extra arg", { command: "get", args: { id: "ok", smuggle: "yes" } }],
      ["null arg object", { command: "get", args: null, invalid: true }],
      ["proto key smuggle", { command: "get", args: JSON.parse('{"__proto__":{"polluted":true},"id":"ok"}') }],
    ];
    for (const [label, inbound] of bad) {
      const reply = await reg.dispatch(null, inbound);
      assert.equal(reply.ok, false, label);
      assert.equal(reply.code, "BAD_ARGS", label);
    }
    const good = await reg.dispatch(null, { command: "get", args: { id: "abc", n: 5, flag: true, mode: "a" } });
    assert.deepEqual(good, { ok: true, data: "abc" });
  });

  it("handler failures map to stable lanes (never reject the promise chain)", async () => {
    const reg = new BridgeRegistry([
      { id: "boom", args: {}, run: () => { throw new Error("kablam"); } },
      { id: "nf", args: {}, run: () => { throw new Error("task not found: x"); } },
    ]);
    const an = await reg.dispatch(null, { command: "boom" });
    assert.equal(an.code, "HANDLER_FAILED");
    assert.match(an.message, /kablam/);
    const nf = await reg.dispatch(null, { command: "nf" });
    assert.equal(nf.code, "NOT_FOUND");
  });

  it("bridge version + fingerprint stable across builds (contract pinning)", () => {
    assert.equal(BRIDGE_VERSION, "1");
    assert.equal(bridgeFingerprint([..."abc"]).length, 16);
    assert.equal(bridgeFingerprint(["b", "a", "c"]), bridgeFingerprint(["c", "a", "b"]), "order-insensitive");
    assert.notEqual(bridgeFingerprint(["a"]), bridgeFingerprint(["b"]));
  });
});

describe("buildBridge commands (live services)", () => {
  let dir = "";
  let db;
  let services;
  let bridge;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "aice-bridge-"));
    const opened = openDatabase(join(dir, "app.db"));
    db = opened.db;
    services = mkServices(db);
    bridge = buildBridge();
  });
  after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("command surface frozen: exactly the documented ids, sorted", () => {
    assert.deepEqual(bridge.ids(), [
      "agents.sessions",
      "approvals.record",
      "audit.list",
      "mcp.list",
      "mcp.toggle",
      "projects.create",
      "projects.list",
      "skills.list",
      "skills.reviewLogged",
      "tasks.advance",
      "tasks.bundle",
      "tasks.create",
      "tasks.diff",
      "tasks.fail",
      "tasks.list",
      "tasks.mergepreview",
      "tasks.show",
    ]);
  });

  it("CRUD happy path: project → task → bundle → approve → advance (engine-guarded)", async () => {
    const p = (await bridge.dispatch(services, { command: "projects.create", args: { name: "pb-TESTONLY", rootPath: dir } }));
    assert.equal(p.ok, true);
    const project = p.data;
    const t = (await bridge.dispatch(services, { command: "tasks.create", args: { projectId: project.id, title: "via bridge", risk: "high" } }));
    assert.equal(t.ok, true);
    const task = t.data;
    const bundle = await bridge.dispatch(services, { command: "tasks.bundle", args: { taskId: task.id } });
    assert.equal(bundle.ok, true);
    assert.equal(bundle.data.task.title, "via bridge");
    assert.equal(bundle.data.agentRuns.length, 0);
    const ap = await bridge.dispatch(services, { command: "approvals.record", args: { taskId: task.id, kind: "plan" } });
    assert.equal(ap.ok, true, JSON.stringify(ap));
    // engine invariants hold: illegal transitions land as HANDLER_FAILED with code
    const bad = await bridge.dispatch(services, { command: "tasks.advance", args: { taskId: task.id, to: "MERGED" } });
    assert.equal(bad.ok, false);
    assert.match(bad.message, /ENGINE_INVALID_TRANSITION|ENGINE_/);
    // legal forward step works
    const step = await bridge.dispatch(services, { command: "tasks.advance", args: { taskId: task.id } });
    assert.equal(step.ok, true, JSON.stringify(step));
  });

  it("cross-scope reads are refused (T20): tasks.list on a missing/other-scoped project", async () => {
    const reply = await bridge.dispatch(services, { command: "tasks.list", args: { projectId: "no-such-project" } });
    assert.equal(reply.ok, false);
    assert.equal(reply.code, "NOT_FOUND");
  });

  it("agents sessions surface marks transcripts display-only (bounded + redacted)", async () => {
    const p = await (await bridge.dispatch(services, { command: "projects.create", args: { name: "ar-TESTONLY", rootPath: dir } })).data;
    const t = await (await bridge.dispatch(services, { command: "tasks.create", args: { projectId: p.id, title: "sessions" } })).data;
    services.agentRuns.record({
      taskId: t.id,
      phase: "investigate",
      status: "completed",
      rounds: 1,
      toolCalls: 1,
      denials: 0,
      transcriptJson: JSON.stringify([{ role: "assistant", content: `token ghp_TESTONLYabcdefghijklmnopqrstuv ${"x".repeat(30000)}` }]),
      finalText: "note-TESTONLY ghp_TESTONLYabcdefghijklmnopqrstuv",
    });
    const reply = await bridge.dispatch(services, { command: "agents.sessions", args: { taskId: t.id } });
    assert.equal(reply.ok, true);
    const r = reply.data[0];
    assert.ok(r.transcriptJson.length < 21000, "bounded");
    assert.doesNotMatch(r.transcriptJson, /ghp_TESTONLY/, "redacted");
    assert.doesNotMatch(r.finalText, /ghp_TESTONLY/);
  });

  it("mcp.toggle audits content-free; skills.reviewLogged audits", async () => {
    const id = services.mcpServers.upsert({ name: "uix", transport: "stdio", trust: "low", configJson: "{}" });
    const before = services.audit.listByProject("").length; // app-wide not needed — count via target
    const r1 = await bridge.dispatch(services, { command: "mcp.toggle", args: { id, enabled: false } });
    assert.equal(r1.ok, true);
    const r2 = await bridge.dispatch(services, { command: "mcp.toggle", args: { id, enabled: true } });
    assert.equal(r2.ok, true);
    const rows = db.prepare("SELECT action FROM audit_events WHERE target = ?").all(id);
    assert.ok(rows.length >= 2);
    assert.ok(rows.every((r) => typeof r.action === "string" && r.action.startsWith("ui.mcp.")));
    const bad = await bridge.dispatch(services, { command: "mcp.toggle", args: { id: "nope-x", enabled: true } });
    assert.equal(bad.ok, false);
    assert.equal(bad.code, "NOT_FOUND");
    void before;
  });
});

describe("tasks.diff lane (Phase 10 diff viewer)", () => {
  let tmp;
  let services;
  let registry;
  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "aice-diff-"));
    const db = openDatabase(join(tmp, "app.db")).db;
    services = mkServices(db);
    registry = buildBridge();
  });
  after(() => rmSync(tmp, { recursive: true, force: true }));

  it("no workspace yet → null lane, no crash", async () => {
    const p = services.projects.create({ name: "d1", rootPath: tmp, classification: "internal" });
    const t = services.tasks.create({ projectId: p.id, title: "no-ws", risk: "low", classification: "public" });
    const r = await registry.dispatch(services, { command: "tasks.diff", args: { taskId: t.id } });
    assert.equal(r.ok, true);
    assert.equal(r.data.workspace, null);
    assert.equal(r.data.stat, "");
  });

  it("worktree with edits → stat + patch vs base SHA (base→working tree)", async () => {
    // fabricate a minimal repo + workspace row (same geometry WorkspaceService would make)
    const projDir = join(tmp, "repo");
    mkdirSync(projDir, { recursive: true });
    const git = (args) => execFileSync("git", args, { cwd: projDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    git(["init"]); git(["config", "user.email", "t@t"]); git(["config", "user.name", "t"]);
    writeFileSync(join(projDir, "hello.ts"), "export const v = 1;\n");
    git(["add", "."]); git(["commit", "-m", "c1"]);
    const baseSha = git(["rev-parse", "HEAD"]).trim();
    const wtRel = ".aice/worktrees/tt";
    mkdirSync(join(projDir, wtRel), { recursive: true });
    git(["worktree", "add", wtRel, baseSha]);
    // agent's edit arrives in the worktree
    writeFileSync(join(projDir, wtRel, "hello.ts"), "export const v = 2; // changed\n");

    const p = services.projects.create({ name: "d2", rootPath: projDir, classification: "internal" });
    const t = services.tasks.create({ projectId: p.id, title: "ws", risk: "low", classification: "public" });
    const ws = services.workspaces.create({ projectId: p.id, taskId: t.id, path: join(projDir, wtRel), branch: "task/tt", baseSha });

    const r = await registry.dispatch(services, { command: "tasks.diff", args: { taskId: t.id } });
    assert.equal(r.ok, true);
    assert.match(r.data.stat, /hello\.ts/);
    assert.match(r.data.patch, /-export const v = 1;/);
    assert.match(r.data.patch, /\+export const v = 2;/);
    assert.equal(r.data.workspace.id, ws.id);
  });

  it("project scoping: another project's task never resolves a cross-project workspace", async () => {
    const pA = services.projects.create({ name: "d3a", rootPath: join(tmp, "a"), classification: "internal" });
    const pB = services.projects.create({ name: "d3b", rootPath: join(tmp, "b"), classification: "internal" });
    const tB = services.tasks.create({ projectId: pB.id, title: "b", risk: "low", classification: "public" });
    services.workspaces.create({ projectId: pA.id, path: "/tmp/x", branch: "x", baseSha: "0".repeat(40) });
    const r = await registry.dispatch(services, { command: "tasks.diff", args: { taskId: tB.id } });
    assert.equal(r.ok, true);
    assert.equal(r.data.workspace, null);
  });
});

describe("tasks.mergepreview lane (Phase 11)", () => {
  let tmp;
  let services;
  let registry;
  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "aice-merge-"));
    const db = openDatabase(join(tmp, "app.db")).db;
    services = mkServices(db);
    registry = buildBridge();
  });
  after(() => rmSync(tmp, { recursive: true, force: true }));

  function fixtureRepo(name, conflict) {
    const dir = join(tmp, name);
    mkdirSync(dir, { recursive: true });
    const git = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    git(["init"]); git(["config", "user.email", "t@t"]); git(["config", "user.name", "t"]);
    writeFileSync(join(dir, "f.txt"), "base\n");
    git(["add", "."]); git(["commit", "-m", "base"]);
    const baseSha = git(["rev-parse", "HEAD"]).trim();
    git(["checkout", "-b", "task/one"]);
    writeFileSync(join(dir, "f.txt"), "task side\n");
    writeFileSync(join(dir, "taskonly.txt"), "from task\n");
    git(["add", "."]); git(["commit", "-m", "task work"]);
    git(["checkout", "master"]);
    writeFileSync(join(dir, "f.txt"), conflict ? "master rivalling line\n" : "base\n");
    if (!conflict) writeFileSync(join(dir, "masteronly.txt"), "m\n");
    git(["add", "."]); git(["commit", "-m", "master work"]);
    return { dir, baseSha };
  }

  it("clean preview: mergeable=true, no conflicts", async () => {
    const { dir, baseSha } = fixtureRepo("cleanrepo", false);
    const p = services.projects.create({ name: "mp-clean", rootPath: dir, classification: "internal" });
    const t = services.tasks.create({ projectId: p.id, title: "clean", risk: "low", classification: "public" });
    const wtRel = ".aice/worktrees/mp";
    mkdirSync(join(dir, wtRel), { recursive: true });
    execFileSync("git", ["worktree", "add", wtRel, "task/one"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    services.workspaces.create({ projectId: p.id, taskId: t.id, path: join(dir, wtRel), branch: "task/one", baseSha });
    const r = await registry.dispatch(services, { command: "tasks.mergepreview", args: { taskId: t.id } });
    assert.equal(r.ok, true);
    assert.equal(r.data.mergeable, true);
    assert.deepEqual(r.data.conflicts, []);
    assert.equal(r.data.targetRef, "master");
  });

  it("conflicting preview: mergeable=false with the exact conflicted file list", async () => {
    const { dir, baseSha } = fixtureRepo("conflictrepo", true);
    const p = services.projects.create({ name: "mp-conf", rootPath: dir, classification: "internal" });
    const t = services.tasks.create({ projectId: p.id, title: "conf", risk: "low", classification: "public" });
    const wtRel = ".aice/worktrees/mp2";
    mkdirSync(join(dir, wtRel), { recursive: true });
    execFileSync("git", ["worktree", "add", wtRel, "task/one"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    services.workspaces.create({ projectId: p.id, taskId: t.id, path: join(dir, wtRel), branch: "task/one", baseSha });
    const r = await registry.dispatch(services, { command: "tasks.mergepreview", args: { taskId: t.id } });
    assert.equal(r.ok, true);
    assert.equal(r.data.mergeable, false);
    assert.deepEqual(r.data.conflicts, ["f.txt"]);
  });

  it("runAllowExit kernel: unacceptable non-zero still throws EXEC_FAILED (fail-closed)", () => {
    return (async () => {
      const { GitRunner } = await import("../../../packages/git/src/runner.ts");
      const { dir } = fixtureRepo("kernrepo", false);
      const runner = new GitRunner(dir);
      const res = runner.runAllowExit(["git", "merge-tree", "--write-tree", "master", "task/one"], [1]);
      assert.ok(typeof res.status === "number");
      // unacceptable status (e.g. rev-parse of a bogus ref) still throws
      assert.throws(() => runner.runAllowExit(["git", "rev-parse", "--verify", "definitely-not-a-ref-AICE"], []), (e) => e.code === "EXEC_FAILED");
      // argv-boundary invariant: a metachar operand is handed to git as ONE argv
      // element — no shell ever interprets it. Proof: status 1 (git rejects the
      // operand) and stdout has NO "wc would have succeeded" number.
      const pipeRes = runner.runAllowExit(["git", "rev-list | wc -l"], [1]);
      assert.equal(pipeRes.status, 1);
      assert.ok(!/^\s*\d+\s*$/.test(pipeRes.stdout));
    })();
  });
});
