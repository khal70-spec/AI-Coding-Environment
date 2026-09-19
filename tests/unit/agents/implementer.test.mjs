// Unit: implementer flow + test.exec verdict extraction (P4.4) — real fixture repo,
// REAL test.exec (npm test in a sandboxed cwd-jailed child), scripted model transport.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRunner } from "../../../packages/tools/src/runtime.ts";
import { FS_TOOLS } from "../../../packages/tools/src/fs-tools.ts";
import { TEST_RUNNER_TOOLS } from "../../../packages/tools/src/test-runner-tool.ts";
import { GIT_TOOLS } from "../../../packages/tools/src/git-tools.ts";
import { implement } from "../../../packages/agents/src/implementer.ts";

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

function fixtureProject({ buggy }) {
  const root = mkdtempSync(join(tmpdir(), "aice-impl-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "fixture-TESTONLY", private: true, scripts: { test: "node test.js" } }),
  );
  writeFileSync(join(root, "test.js"), buggy
    ? "console.log('failing-start-TESTONLY'); process.exit(1);\n"
    : "console.log('green-TESTONLY');\n");
  return root;
}

describe("implement", () => {
  it("fix loop: edit → test fails → edit again (approved) → green, verdicts recorded", async () => {
    const root = fixtureProject({ buggy: true });
    // Model loop: test → see fail → fs.edit replace exit(1) with exit(0) → test → summary.
    const transport = scripted([
      'First verify the failure.\n```tool\n{"tool":"test.exec","args":{}}\n```',
      'Bug confirmed; apply the fix.\n```tool\n{"tool":"fs.edit","args":{"path":"test.js","search":"process.exit(1);","replace":"process.exit(0);"}}\n```',
      'Verify green.\n```tool\n{"tool":"test.exec","args":{}}\n```',
      "IMPLEMENTATION SUMMARY: fixed test.js exit code; tests green; no remaining risk.",
    ]);
    const res = await implement(
      {
        runner: new ToolRunner([...FS_TOOLS, ...TEST_RUNNER_TOOLS, ...GIT_TOOLS]),
        jailRoot: root,
        policyCtx: PCTX,
        transport,
        task: { title: "Make tests pass", plan: "## Steps\n1. flip exit code (verify: test.exec)" },
        approved: true, // edits pre-approved by Plan §33 evidence
      },
      { maxIterations: 8 },
    );
    assert.equal(res.status, "completed", JSON.stringify(res.transcript, null, 1));
    assert.deepEqual(res.testVerdicts.map((v) => v.verdict), ["fail", "pass"]);
    assert.equal(res.testVerdicts.length, 2);
    assert.match(readFileSync(join(root, "test.js"), "utf8"), /process\.exit\(0\)/);
    assert.match(res.summary, /IMPLEMENTATION SUMMARY/);
  }, 120_000);

  it("no-approval flow: overwrite attempt stalls awaiting-approval before edits happen", async () => {
    const root = fixtureProject({ buggy: true });
    const transport = scripted([
      'Overwrites everywhere.\n```tool\n{"tool":"fs.write","args":{"path":"test.js","content":"process.exit(0);"}}\n```',
    ]);
    const res = await implement(
      {
        runner: new ToolRunner([...FS_TOOLS, ...TEST_RUNNER_TOOLS]),
        jailRoot: root,
        policyCtx: PCTX,
        transport,
        task: { title: "Make tests pass", plan: "x" },
      },
    );
    assert.equal(res.status, "awaiting-approval");
    assert.equal(res.pendingApproval.tool, "fs.write");
    assert.match(readFileSync(join(root, "test.js"), "utf8"), /exit\(1\)/, "no write happened");
  });

  it("git.exec shapes stay policy-gated: commit attempt inside plan is approval-stalled", async () => {
    const root = fixtureProject({ buggy: false });
    const transport = scripted([
      '```tool\n{"tool":"git.exec","args":{"argv":["commit","-m","rogue"]}}\n```',
    ]);
    const res = await implement(
      {
        runner: new ToolRunner([...FS_TOOLS, ...TEST_RUNNER_TOOLS, ...GIT_TOOLS]),
        jailRoot: root,
        policyCtx: PCTX,
        transport,
        task: { title: "try to commit", plan: "n/a" },
      },
    );
    assert.equal(res.status, "awaiting-approval");
    assert.equal(res.pendingApproval.tool, "git.exec");
  });
});
