// Unit: TestResultsDao / FindingsDao (P3.4 evidence tables).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openDatabase,
  ProjectsDao,
  TasksDao,
  TestResultsDao,
  FindingsDao,
} from "../../../packages/storage/src/index.ts";

describe("test_results / security_findings DAOs", () => {
  let dir = "";
  let db, testResults, findings, taskA, taskB;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "aice-find-"));
    db = openDatabase(join(dir, "app.db")).db;
    const projects = new ProjectsDao(db);
    const tasks = new TasksDao(db);
    const p = projects.create({ name: "TESTONLY", rootPath: "/tmp/TESTONLY" });
    taskA = tasks.create({ projectId: p.id, title: "A TESTONLY" });
    taskB = tasks.create({ projectId: p.id, title: "B TESTONLY" });
    testResults = new TestResultsDao(db);
    findings = new FindingsDao(db);
  });
  after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("test_results round-trip with recency by task", () => {
    testResults.add(taskA.id, { suite: "unit", passed: 9, failed: 1, skipped: 0 });
    const second = testResults.add(taskA.id, { suite: "unit", passed: 12, failed: 0, skipped: 2 });
    testResults.add(taskB.id, { suite: "e2e", passed: 3, failed: 0, skipped: 0, outputRef: "runs/TESTONLY.log" });
    const latestA = testResults.latestByTask(taskA.id);
    assert.equal(latestA.id, second.id);
    assert.equal(latestA.failed, 0);
    assert.equal(testResults.byTask(taskA.id).length, 2);
    assert.equal(testResults.byTask(taskB.id).length, 1);
    assert.equal(testResults.latestByTask("no-such-task"), null);
  });

  it("findings round-trip, blockers counted by open status + high/critical severity", () => {
    findings.addMany(taskA.id, [
      { severity: "info", ruleId: "semgrep::style", summary: "fmt (TESTONLY)" },
      { severity: "high", ruleId: "gitleaks::generic-api-key", location: "src/x.ts:3", summary: "key (TESTONLY)" },
      { severity: "critical", ruleId: "osv::CVE-2024-TESTONLY", summary: "rce (TESTONLY)" },
    ]);
    assert.equal(findings.countByTask(taskA.id), 3);
    assert.equal(findings.openBlockers(taskA.id).length, 2);
    const info = findings.byTask(taskA.id)[0];
    findings.updateStatus(info.id, "wontfix");
    const crit = findings.byTask(taskA.id).at(-1);
    findings.updateStatus(crit.id, "fixed");
    assert.equal(findings.openBlockers(taskA.id).length, 1);
    findings.updateStatus(findings.openBlockers(taskA.id)[0].id, "acknowledged");
    assert.equal(findings.openBlockers(taskA.id).length, 0);
    assert.equal(findings.countByTask(taskB.id), 0);
  });

  it("rejects invalid severities/statuses at the schema layer", () => {
    assert.throws(() => findings.add(taskA.id, { severity: "severe", ruleId: "x", summary: "y" }));
    const row = findings.add(taskA.id, { severity: "low", ruleId: "x", summary: "y" });
    assert.throws(() => findings.updateStatus(row.id, "closed"));
  });

  it("task FK enforced — findings for unknown tasks refuse", () => {
    assert.throws(() => findings.add("ghost-task-TESTONLY", { severity: "low", ruleId: "x", summary: "y" }));
    assert.throws(() => testResults.add("ghost-task-TESTONLY", { suite: "s", passed: 1, failed: 0 }));
  });
});
