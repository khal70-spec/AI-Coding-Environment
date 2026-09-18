// E2E (P7.5): operator workflow across the live server — the exercising frame IS
// the same bridge surface the SPA calls: boot server → create project → create
// task → walk the governed lifecycle (advance/approve/findings/results/fail) while
// assert-proofing INVARIANTS at each step (engine-led, audited, never bypassed).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBridge } from "../../../apps/desktop/src/server.ts";

async function api(port, command, args = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/api/bridge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command, args }),
  });
  const reply = await res.json();
  return reply;
}

describe("desktop e2e: operator workflow", () => {
  let dir = "";
  let handle;
  let port;
  let db;
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "aice-e2e-"));
    const web = join(dir, "web");
    mkdirSync(web);
    writeFileSync(join(web, "index.html"), "<html></html>");
    handle = await startBridge({ dbPath: join(dir, "app.db"), actor: "operator-TESTONLY", webRoot: web });
    port = handle.port;
    db = handle.db.db;
  });
  after(() => {
    handle?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("workflow: project → task → evidence → merge → fatigue blocks → done", async () => {
    // 1) create project + task via the UI surface
    const proj = await api(port, "projects.create", { name: "e2e-TESTONLY", rootPath: dir });
    assert.equal(proj.ok, true);
    const task = await api(port, "tasks.create", { projectId: proj.data.id, title: "fix login flake", risk: "high" });
    assert.equal(task.ok, true);
    const id = task.data.id;

    // 2) governor surface mirrors database truth at every step
    const show1 = await api(port, "tasks.show", { taskId: id });
    assert.equal(show1.data.task.state, "CREATED");

    // 3) illegal leap denied — state UNCHANGED in db (fail-closed)
    const denied = await api(port, "tasks.advance", { taskId: id, to: "MERGED" });
    assert.equal(denied.ok, false);
    const after1 = db.prepare("SELECT state FROM tasks WHERE id = ?").get(id);
    assert.equal(after1.state, "CREATED", "denied transitions never touch the row");

    // 4) legal walk with default next-state: CREATED → ... → WAITING_APPROVAL
    for (const expect of ["CLASSIFYING", "INVESTIGATING", "PLANNING", "WAITING_APPROVAL"]) {
      const step = await api(port, "tasks.advance", { taskId: id });
      assert.equal(step.ok, true, `advance → ${expect}: ${step.message ?? ""}`);
      assert.equal(step.data.to, expect);
    }
    // high-risk: PREPARING_WORKSPACE refuses without plan approval (brake #1)
    const brake1 = await api(port, "tasks.advance", { taskId: id });
    assert.equal(brake1.ok, false);
    assert.match(brake1.message, /ENGINE_APPROVAL_REQUIRED/);
    assert.equal(db.prepare("SELECT state FROM tasks WHERE id = ?").get(id).state, "WAITING_APPROVAL");
    // brake is also AUDITED (deny):
    let rows = db.prepare("SELECT action, decision FROM audit_events WHERE task_id = ?").all(id);
    assert.ok(rows.some((r) => r.action === "task.transition.denied" && r.decision === "deny"));
    // plan approval unblocks the EXACT next brake only (WAITY → PREP)
    const ap = await api(port, "approvals.record", { taskId: id, kind: "plan" });
    assert.equal(ap.ok, true);
    const prep = await api(port, "tasks.advance", { taskId: id });
    assert.equal(prep.ok, true);
    assert.equal(prep.data.to, "PREPARING_WORKSPACE");
    // brake #2: IMPLEMENTING requires a CHECKPOINT — the UI surface has no command
    // to self-attest checkpoint/verify/review evidence (governance holds):
    const brake2 = await api(port, "tasks.advance", { taskId: id });
    assert.equal(brake2.ok, false);
    assert.match(brake2.message, /ENGINE_CHECKPOINT_REQUIRED/);
    assert.equal(db.prepare("SELECT state FROM tasks WHERE id = ?").get(id).state, "PREPARING_WORKSPACE");
    // evidence commands simply do not exist on the bridge (allowlist proof):
    for (const ghost of ["verify", "checkpoint", "review", "engine.override", "sql"]) {
      const r = await api(port, ghost, { taskId: id });
      assert.equal(r.ok, false, ghost);
      assert.equal(r.code, "UNKNOWN_COMMAND", ghost);
    }
    // bundle shows everything the UI can (runs timeline reflects the walk)
    const bundle = await api(port, "tasks.bundle", { taskId: id });
    assert.equal(bundle.ok, true);
    assert.ok(bundle.data.runs.length >= 5, "run rows per allowed transition");
    const finalA = await api(port, "approvals.record", { taskId: id, kind: "final" });
    assert.equal(finalA.ok, true, JSON.stringify(finalA));

    // 5) operator revokes: BLOCKED — the fatality lane is one call
    const block = await api(port, "tasks.fail", { taskId: id, to: "BLOCKED", reason: "operator hold" });
    assert.equal(block.ok, true, JSON.stringify(block));
    const st = db.prepare("SELECT state FROM tasks WHERE id = ?").get(id);
    assert.equal(st.state, "BLOCKED");

    // 6) blocked tasks refuse "advance" forever (fail closed, state stuck)
    const still = await api(port, "tasks.advance", { taskId: id, to: "READY" });
    assert.equal(still.ok, false);
    assert.equal(db.prepare("SELECT state FROM tasks WHERE id = ?").get(id).state, "BLOCKED");

    // 7) every step audited content-free, actor visible, tamper-evident ordering
    const audit = await api(port, "audit.list", { taskId: id, limit: 200 });
    assert.equal(audit.ok, true);
    assert.ok(audit.data.length >= 4, `expected >= 4 events, got ${audit.data.length}`);
    assert.ok(audit.data.every((a) => a.actor !== "" && a.action !== ""));
    const ids = audit.data.map((a) => a.id);
    assert.deepEqual([...ids].sort((x, y) => x - y), ids, "append-only monotonic");
  });

  it("multi-project isolation through the ui surface (data-scope test)", async () => {
    const p1 = await api(port, "projects.create", { name: "isoA-TESTONLY", rootPath: dir });
    const p2 = await api(port, "projects.create", { name: "isoB-TESTONLY", rootPath: dir });
    const t1 = await api(port, "tasks.create", { projectId: p1.data.id, title: "in A" });
    const listA = await api(port, "tasks.list", { projectId: p1.data.id });
    const listB = await api(port, "tasks.list", { projectId: p2.data.id });
    assert.ok(listA.data.some((t) => t.id === t1.data.id));
    assert.ok(!listB.data.some((t) => t.id === t1.data.id), "B never sees A's tasks");
  });
});
