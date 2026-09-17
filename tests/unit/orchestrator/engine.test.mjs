// Unit: TaskEngine — guarded transitions persisted with audit; evidence from the
// audit trail drives approval/checkpoint/verify/reviewer guards.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openDatabase, ProjectsDao, TasksDao, RunsDao, AuditDao,
} from "../../../packages/storage/src/index.ts";
import { TaskEngine, nextHappyPath } from "../../../packages/orchestrator/src/index.ts";
import { MAX_FIX_ATTEMPTS } from "../../../packages/orchestrator/src/index.ts";

describe("TaskEngine", () => {
  let dir = "";
  let db, projects, tasks, runs, audit, engine, project;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "aice-eng-"));
    db = openDatabase(join(dir, "app.db")).db;
    projects = new ProjectsDao(db);
    tasks = new TasksDao(db);
    runs = new RunsDao(db);
    audit = new AuditDao(db);
    engine = new TaskEngine({ tasks, runs, audit });
    project = projects.create({ name: "TESTONLY", rootPath: "/tmp/TESTONLY" });
  });
  after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function newTask(risk = "low") {
    return tasks.create({ projectId: project.id, title: `TESTONLY ${risk}`, risk });
  }
  function advance(id, actor = "TESTONLY") {
    return engine.transition({ taskId: id, actor });
  }

  it("nextHappyPath covers the full forward chain only", () => {
    assert.equal(nextHappyPath("CREATED"), "CLASSIFYING");
    assert.equal(nextHappyPath("APPROVED"), "MERGED");
    assert.equal(nextHappyPath("FIXING"), "IMPLEMENTING");
    assert.equal(nextHappyPath("MERGED"), null);
    assert.equal(nextHappyPath("CANCELLED"), null);
    assert.equal(nextHappyPath("BLOCKED"), null);
  });

  it("walks a low-risk task to MERGED with audit at every step", () => {
    const t = newTask("low");
    const chain = ["CLASSIFYING", "INVESTIGATING", "PLANNING", "WAITING_APPROVAL", "PREPARING_WORKSPACE"];
    // checkpoint evidence required before IMPLEMENTING
    for (const s of chain) {
      const r = advance(t.id);
      assert.equal(r.ok, true, s);
    }
    let r = advance(t.id); // → IMPLEMENTING without checkpoint: denied
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "CHECKPOINT_REQUIRED");
    engine.recordCheckpoint(t.id, { sha: "a".repeat(40), branch: "main", dirty: false }, "TESTONLY");
    for (const s of ["IMPLEMENTING", "TESTING", "SECURITY_REVIEW", "AI_REVIEW", "VERIFYING", "READY"]) {
      r = advance(t.id);
      assert.equal(r.ok, true, s);
    }
    r = advance(t.id); // → APPROVED (low risk: no final approval needed)
    assert.equal(r.ok, true);
    r = advance(t.id); // → MERGED denied: verify + reviewer evidence missing
    assert.equal(r.ok, false);
    engine.recordVerify(t.id, { testsGreen: true, scansGreen: true }, "TESTONLY");
    r = advance(t.id);
    assert.equal(r.ok, false, "still denied: no independent reviewer");
    engine.recordReview(t.id, "code-reviewer", "TESTONLY");
    r = advance(t.id);
    assert.equal(r.ok, true, "MERGED with full evidence");
    assert.equal(tasks.get(t.id).state, "MERGED");
    const events = audit.listByTask(t.id).filter((e) => e.action === "task.transition");
    assert.ok(events.length >= 13, "every transition audited");
    assert.ok(audit.listByTask(t.id).some((e) => e.action === "task.transition.denied"), "denied attempt audited too");
  });

  it("high-risk task requires plan + final approvals, denials audited, state unchanged on deny", () => {
    const t = newTask("high");
    for (const s of ["CLASSIFYING", "INVESTIGATING", "PLANNING", "WAITING_APPROVAL"]) {
      assert.equal(advance(t.id).ok, true, s);
    }
    let r = advance(t.id); // PREPARING_WORKSPACE: APPROVAL_REQUIRED
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "APPROVAL_REQUIRED");
    assert.equal(tasks.get(t.id).state, "WAITING_APPROVAL", "state unchanged on deny");
    const denied = audit.listByTask(t.id).filter((e) => e.action === "task.transition.denied");
    assert.equal(denied.length, 1);
    assert.equal(denied[0].detail.code, "APPROVAL_REQUIRED");
    engine.approve(t.id, "plan", "human-TESTONLY");
    assert.equal(advance(t.id).ok, true, "approval from audit trail unlocks the guard");
    engine.recordCheckpoint(t.id, { sha: "b".repeat(40), branch: "main", dirty: false }, "TESTONLY");
    for (const s of ["IMPLEMENTING", "TESTING", "SECURITY_REVIEW", "AI_REVIEW", "VERIFYING", "READY"]) {
      assert.equal(advance(t.id).ok, true, s);
    }
    r = advance(t.id); // APPROVED: final approval required
    assert.equal(r.ok, false);
    engine.approve(t.id, "final", "human-TESTONLY");
    assert.equal(advance(t.id).ok, true);
    engine.recordVerify(t.id, { testsGreen: true, scansGreen: true }, "TESTONLY");
    engine.recordReview(t.id, "code-reviewer", "TESTONLY");
    assert.equal(advance(t.id).ok, true, "MERGED");
  });

  it("fix loop budget is enforced from run history", () => {
    const t = newTask("low");
    engine.recordCheckpoint(t.id, { sha: "c".repeat(40), branch: "main", dirty: false }, "TESTONLY");
    // Reach IMPLEMENTING
    for (const s of ["CLASSIFYING", "INVESTIGATING", "PLANNING", "WAITING_APPROVAL", "PREPARING_WORKSPACE", "IMPLEMENTING"]) {
      assert.equal(advance(t.id).ok, true, s);
    }
    // Loop MAX_FIX_ATTEMPTS times: → TESTING → FIXING → IMPLEMENTING
    for (let i = 0; i < MAX_FIX_ATTEMPTS; i++) {
      assert.equal(advance(t.id).ok, true, "→ TESTING");
      assert.equal(engine.transition({ taskId: t.id, to: "FIXING", actor: "TESTONLY" }).ok, true, "→ FIXING");
      assert.equal(advance(t.id).ok, true, `fix attempt ${i + 1}`);
    }
    assert.equal(tasks.get(t.id).state, "IMPLEMENTING");
    assert.equal(advance(t.id).ok, true, "→ TESTING after budget spent");
    assert.equal(engine.transition({ taskId: t.id, to: "FIXING", actor: "TESTONLY" }).ok, true, "→ FIXING");
    const r = advance(t.id); // FIXING → IMPLEMENTING would be attempt #4 — denied
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "RETRY_BUDGET_EXHAUSTED");
  });

  it("terminal states reject any forward transition", () => {
    const t = newTask("low");
    const rf = engine.transition({ taskId: t.id, to: "CANCELLED", actor: "TESTONLY" });
    assert.equal(rf.ok, true);
    const r = advance(t.id);
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "TERMINAL_STATE");
  });
});
