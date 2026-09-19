// Unit: AgentRunsDao — agent-loop session persistence (Plan §26, P4.5).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, ProjectsDao, TasksDao, AgentRunsDao } from "../../../packages/storage/src/index.ts";

describe("AgentRunsDao", () => {
  let dir = "";
  let db;
  let projects;
  let tasks;
  let agentRuns;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "aice-agentruns-"));
    const opened = openDatabase(join(dir, "app.db"));
    db = opened.db;
    projects = new ProjectsDao(db);
    tasks = new TasksDao(db);
    agentRuns = new AgentRunsDao(db);
  });
  after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("record/get/listByTask/latestByPhase round-trip", () => {
    const p = projects.create({ name: "TESTONLY-ar", rootPath: "/tmp/TESTONLY-ar" });
    const t = tasks.create({ projectId: p.id, title: "agent persistence task" });
    const r1 = agentRuns.record({
      taskId: t.id,
      phase: "investigate",
      modelId: "local/test-model",
      status: "completed",
      rounds: 3,
      toolCalls: 2,
      denials: 1,
      transcriptJson: JSON.stringify([{ role: "assistant", content: "memo-TESTONLY" }]),
      finalText: "final note TESTONLY",
    });
    assert.equal(r1.id.length > 0, true);
    assert.equal(agentRuns.get(r1.id).finalText, "final note TESTONLY");
    assert.equal(agentRuns.get(r1.id).denials, 1);
    const r2 = agentRuns.record({
      taskId: t.id,
      phase: "investigate",
      status: "awaiting-approval",
      rounds: 1,
      toolCalls: 1,
      denials: 0,
      transcriptJson: "[]",
    });
    assert.equal(r2.modelId, null);
    assert.equal(agentRuns.listByTask(t.id).length, 2);
    assert.equal(agentRuns.latestByPhase(t.id, "investigate")?.id, r2.id);
    assert.equal(agentRuns.latestByPhase(t.id, "plan"), undefined);
  });

  it("cross-scope isolation: listing is per task (T20); FK to tasks enforced", () => {
    const p = projects.create({ name: "TESTONLY-ar2", rootPath: "/tmp/TESTONLY-ar2" });
    const ta = tasks.create({ projectId: p.id, title: "A" });
    const tb = tasks.create({ projectId: p.id, title: "B" });
    agentRuns.record({
      taskId: ta.id,
      phase: "plan",
      status: "completed",
      rounds: 2,
      toolCalls: 1,
      denials: 0,
      transcriptJson: "[]",
      finalText: "plan A",
    });
    assert.equal(agentRuns.listByTask(tb.id).length, 0);
    assert.throws(
      () =>
        agentRuns.record({
          taskId: "no-such-task",
          phase: "plan",
          status: "completed",
          rounds: 0,
          toolCalls: 0,
          denials: 0,
          transcriptJson: "[]",
        }),
      /FOREIGN KEY|constraint/i,
    );
  });

  it("status/phase values are CHECK-constrained (fail closed on garbage)", () => {
    const p = projects.create({ name: "TESTONLY-ar3", rootPath: "/tmp/TESTONLY-ar3" });
    const t = tasks.create({ projectId: p.id, title: "C" });
    assert.throws(() =>
      db
        .prepare(
          "INSERT INTO agent_runs (id, task_id, phase, model_id, status, rounds, tool_calls, denials, transcript_json) VALUES ('x9', ?, 'rogue', NULL, 'completed', 0, 0, 0, '[]')",
        )
        .run(t.id),
    );
  });
});
