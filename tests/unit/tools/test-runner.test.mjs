// Unit: test.exec tool — stack-allowlisted argv, cwd jail, normalized verdict (P3.3).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRunner } from "../../../packages/tools/src/runtime.ts";
import { TEST_RUNNER_TOOLS, normalizeTestResult } from "../../../packages/tools/src/test-runner-tool.ts";

function untag(output) {
  const lines = output.split("\n");
  assert.ok(lines[0].startsWith("<<<UNTRUSTED-TOOL-OUTPUT"));
  assert.equal(lines[lines.length - 1], "<<<END-UNTRUSTED-TOOL-OUTPUT>>>");
  return lines.slice(1, -1).join("\n");
}

const GRANT = {
  toolsAllow: ["test.exec"],
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

function nodeProject(testScript) {
  const root = mkdtempSync(join(tmpdir(), "aice-texec-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "fixture-TESTONLY", private: true, scripts: { test: `node test.js` } }),
  );
  writeFileSync(join(root, "test.js"), testScript);
  return root;
}

function setup(root) {
  const runner = new ToolRunner(TEST_RUNNER_TOOLS);
  const call = (args = {}) =>
    runner.call(
      { tool: "test.exec", args, cwd: root, risk: "low", classification: "public" },
      {
        actor: "agent:tester",
        risk: "low",
        classification: "public",
        grant: GRANT,
        policyCtx: PCTX,
        jailRoot: root,
      },
    );
  return { call, body: (r) => untag(r.output) };
}

describe("test.exec through ToolRunner", () => {
  it("pass fixture → verdict pass, exit 0, argv echoed allowlisted", async () => {
    const root = nodeProject('console.log("all-green-TESTONLY");');
    const { call, body } = setup(root);
    const res = await call();
    assert.equal(res.ok, true, body(res));
    const b = body(res);
    assert.match(b, /test\.exec verdict: pass \(stack node via package\.json\)/);
    assert.match(b, /argv: npm test/);
    assert.match(b, /all-green-TESTONLY/);
  }, 60_000);

  it("fail fixture → verdict fail, exit 1, tail captured", async () => {
    const root = nodeProject('console.error("boom-marker-TESTONLY"); process.exit(1);');
    const { call, body } = setup(root);
    const res = await call();
    assert.equal(res.ok, true, body(res));
    const b = body(res);
    assert.match(b, /verdict: fail/);
    assert.match(b, /exit: 1/);
    assert.match(b, /boom-marker-TESTONLY/);
  }, 60_000);

  it("no testable stack → preflight neverAllow → POLICY_DENIED (nothing executed)", async () => {
    const root = mkdtempSync(join(tmpdir(), "aice-texec-none-"));
    writeFileSync(join(root, "README.txt"), "plain\n");
    const { call } = setup(root);
    const res = await call();
    assert.equal(res.ok, false);
    assert.equal(res.code, "POLICY_DENIED");
  });

  it("hung suite → timeout verdict under the tool's own cap", async () => {
    const root = nodeProject("setInterval(() => {}, 1000);");
    const { call, body } = setup(root);
    const started = Date.now();
    const res = await call({ timeoutMs: 2000 });
    const elapsed = Date.now() - started;
    assert.equal(res.ok, true, body(res));
    assert.match(body(res), /verdict: timeout/);
    assert.ok(elapsed < 30_000, `tool-level timeout must fire (~2s), took ${elapsed}ms`);
  }, 45_000);

  it("extraArgs append after the allowlisted prefix (still argv data)", async () => {
    const root = nodeProject(";");
    const { call, body } = setup(root);
    const res = await call({ extraArgs: ["--", "--reporter=spec"] });
    assert.equal(res.ok, true, body(res));
    assert.match(body(res), /argv: npm test -- --reporter=spec/);
  }, 60_000);
});

describe("normalizeTestResult (pure)", () => {
  const info = { kind: "node", marker: "package.json", testArgv: ["npm", "test"] };
  it("maps exit/timedOut into verdict", () => {
    assert.equal(normalizeTestResult(info, ["npm", "test"], { exitCode: 0, timedOut: false, stdout: "", stderr: "" }, 5).verdict, "pass");
    assert.equal(normalizeTestResult(info, ["npm", "test"], { exitCode: 2, timedOut: false, stdout: "", stderr: "" }, 5).verdict, "fail");
    assert.equal(normalizeTestResult(info, ["npm", "test"], { exitCode: null, timedOut: false, stdout: "", stderr: "" }, 5).verdict, "error");
    assert.equal(normalizeTestResult(info, ["npm", "test"], { exitCode: null, timedOut: true, stdout: "", stderr: "" }, 5).verdict, "timeout");
  });
  it("tailLog keeps only the last 4KiB", () => {
    const big = "x".repeat(10_000) + "ENDMARK";
    const norm = normalizeTestResult(info, ["npm", "test"], { exitCode: 0, timedOut: false, stdout: big, stderr: "" }, 1);
    assert.ok(norm.tailLog.length <= 4096 + 1);
    assert.match(norm.tailLog, /ENDMARK\n?$/);
  });
});
