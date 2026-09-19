// Unit: architect/planner flow (P4.3).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRunner } from "../../../packages/tools/src/runtime.ts";
import { FS_TOOLS } from "../../../packages/tools/src/fs-tools.ts";
import { architectPlan, planLooksStructured } from "../../../packages/agents/src/architect.ts";

const PCTX = { workspaceLocked: false, providerMaxClassification: "confidential" };

function scripted(steps) {
  let i = 0;
  return async () => {
    assert.ok(i < steps.length, `script exhausted at step ${i + 1}`);
    const content = steps[i];
    i += 1;
    return { content };
  };
}

const PLAN_TEXT = [
  "## Goal",
  "Add /api/health returning 200.",
  "## Steps (numbered; each lists files + verification)",
  "1. Edit src/route.ts to add /health (verify: test.exec)",
  "2. Extend tests (verify: test.exec green — counted as one verify step, not two)",
  "## Risk notes & rollback",
  "low risk",
  "## Definition of done",
  "tests green",
].join("\n");

describe("architectPlan", () => {
  it("writes PLAN.md as a NEW file (no approval needed) and returns the plan", async () => {
    const root = mkdtempSync(join(tmpdir(), "aice-arch-"));
    const transport = scripted([
      'Write the plan artifact.\n```tool\n{"tool":"fs.write","args":{"path":"PLAN.md","content":"' + PLAN_TEXT.replace(/\n/g, "\\n").replace(/"/g, '\\"') + '"}}\n```',
      PLAN_TEXT,
    ]);
    const res = await architectPlan(
      {
        runner: new ToolRunner(FS_TOOLS),
        jailRoot: root,
        policyCtx: PCTX,
        transport,
        task: { title: "Plan health endpoint", investigation: "route.ts owns routes" },
      },
    );
    assert.equal(res.status, "completed");
    assert.match(res.plan, /## Goal/);
    assert.equal(planLooksStructured(res.plan), true);
    assert.equal(existsSync(join(root, "PLAN.md")), true, "plan artifact persisted");
    assert.match(readFileSync(join(root, "PLAN.md"), "utf8"), /## Goal/);
    assert.equal(res.denials, 0);
  });

  it("overwriting an existing PLAN.md stalls into awaiting-approval before any write", async () => {
    const root = mkdtempSync(join(tmpdir(), "aice-arch-"));
    writeFileSync(join(root, "PLAN.md"), "old plan\n");
    const transport = scripted([
      'Rewrite.\n```tool\n{"tool":"fs.write","args":{"path":"PLAN.md","content":"new plan"}}\n```',
    ]);
    const res = await architectPlan(
      {
        runner: new ToolRunner(FS_TOOLS),
        jailRoot: root,
        policyCtx: PCTX,
        transport,
        task: { title: "Update plan", investigation: "x" },
      },
    );
    assert.equal(res.status, "awaiting-approval");
    assert.equal(res.pendingApproval.tool, "fs.write");
    assert.equal(readFileSync(join(root, "PLAN.md"), "utf8"), "old plan\n", "overwrite blocked");
  });

  it("approved resume executes the gated overwrite", async () => {
    const root = mkdtempSync(join(tmpdir(), "aice-arch-"));
    writeFileSync(join(root, "PLAN.md"), "old plan\n");
    const transport = scripted([
      '```tool\n{"tool":"fs.write","args":{"path":"PLAN.md","content":"new plan v2"}}\n```',
      PLAN_TEXT,
    ]);
    const res = await architectPlan(
      {
        runner: new ToolRunner(FS_TOOLS),
        jailRoot: root,
        policyCtx: PCTX,
        transport,
        task: { title: "Update plan (approved)", investigation: "x" },
        approved: true,
      },
    );
    assert.equal(res.status, "completed");
    assert.match(readFileSync(join(root, "PLAN.md"), "utf8"), /new plan v2/);
  });

  it("planLooksStructured sanity", () => {
    assert.equal(planLooksStructured(PLAN_TEXT), true);
    assert.equal(planLooksStructured("just prose, no steps"), false);
    assert.equal(planLooksStructured("## steps\nno numbering"), false);
  });
});
