// Unit: scanner adapters (parse fixtures), scan.exec gating, structured data channel (P3.4).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRunner } from "../../../packages/tools/src/runtime.ts";
import {
  SCANNER_TOOLS,
  countBySeverity,
  parseScannerOutput,
  scannerArgv,
} from "../../../packages/tools/src/scanner-tools.ts";
import { findOnPath } from "../../../packages/tools/src/sandbox-detect.ts";

const GRANT = {
  toolsAllow: ["scan.exec"],
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

const GITLEAKS_FIXTURE = JSON.stringify([
  { RuleID: "generic-api-key", File: "src/keys.txt", StartLine: 3, Description: "Generic API Key (TESTONLY)" },
  { RuleID: "github-token", File: "ci/build.yml", StartLine: 11, Description: "GitHub (TESTONLY)" },
]);
const SEMGREP_FIXTURE = JSON.stringify({
  results: [
    { check_id: "javascript.lang.security.detect-child-process", path: "src/x.ts", start: { line: 42 }, extra: { severity: "WARNING", message: "spawn detected (TESTONLY)" } },
    { check_id: "js.insecure-eval", path: "src/e.ts", start: { line: 7 }, extra: { severity: "ERROR", message: "eval (TESTONLY)" } },
  ],
});
const OSV_FIXTURE = JSON.stringify({
  results: [
    { packages: [
      { package: { name: "lodash", version: "4.17.15" }, vulnerabilities: [
        { id: "GHSA-TESTONLY-1", summary: "prototype pollution (TESTONLY)", database_specific: { severity: "HIGH" } },
        { id: "GHSA-TESTONLY-2", summary: "npm advisory (TESTONLY)" },
      ] },
    ] },
  ],
});
const TRIVY_FIXTURE = JSON.stringify({
  Results: [
    { Target: "package-lock.json", Vulnerabilities: [
      { VulnerabilityID: "CVE-2024-TESTONLY", Severity: "CRITICAL", PkgName: "openssl", Title: "bad cve (TESTONLY)" },
    ], Misconfigurations: [] },
    { Target: "Dockerfile", Vulnerabilities: [], Misconfigurations: [
      { ID: "DS002", Severity: "MEDIUM", Title: "image as root (TESTONLY)" },
    ] },
  ],
});

describe("scanner parsers (fixtures, no binaries required)", () => {
  it("gitleaks JSON → high findings with file:line locations", () => {
    const out = parseScannerOutput("gitleaks", GITLEAKS_FIXTURE);
    assert.equal(out.length, 2);
    assert.equal(out[0].severity, "high");
    assert.equal(out[0].ruleId, "gitleaks::generic-api-key");
    assert.equal(out[0].location, "src/keys.txt:3");
  });

  it("semgrep JSON → severity mapped ERROR/WARNING/INFO", () => {
    const out = parseScannerOutput("semgrep", SEMGREP_FIXTURE);
    assert.equal(out.length, 2);
    assert.equal(out[0].severity, "medium");
    assert.equal(out[1].severity, "high");
    assert.equal(out[0].location, "src/x.ts:42");
    assert.match(out[1].summary, /eval/);
  });

  it("osv-scanner JSON → package@version locations, db severity honored", () => {
    const out = parseScannerOutput("osv-scanner", OSV_FIXTURE);
    assert.equal(out.length, 2);
    assert.equal(out[0].severity, "high");
    assert.equal(out[1].severity, "medium"); // unknown db severity → medium
    assert.equal(out[0].location, "lodash@4.17.15");
    assert.equal(out[1].ruleId, "osv::GHSA-TESTONLY-2");
  });

  it("trivy JSON → vulns + misconfigurations, severity case-fold", () => {
    const out = parseScannerOutput("trivy", TRIVY_FIXTURE);
    assert.equal(out.length, 2);
    assert.equal(out[0].severity, "critical");
    assert.equal(out[0].ruleId, "trivy::CVE-2024-TESTONLY");
    assert.match(out[0].location ?? "", /package-lock\.json/);
    assert.equal(out[1].severity, "medium");
  });

  it("counts by severity", () => {
    const counts = countBySeverity([
      { severity: "critical", ruleId: "a", location: null, summary: "x" },
      { severity: "high", ruleId: "b", location: null, summary: "y" },
      { severity: "high", ruleId: "c", location: null, summary: "z" },
    ]);
    assert.deepEqual(counts, { critical: 1, high: 2, medium: 0, low: 0, info: 0 });
  });

  it("argv builders are argv-only with offline flags", () => {
    assert.deepEqual(scannerArgv("gitleaks", "/w").slice(0, 2), ["gitleaks", "detect"]);
    assert.ok(scannerArgv("osv-scanner", "/w").includes("--offline-vulnerabilities"));
    assert.ok(scannerArgv("trivy", "/w").includes("--skip-db-update"));
    assert.ok(scannerArgv("trivy", "/w").includes("--offline-scan"));
    assert.ok(scannerArgv("semgrep", "/w").includes("--metrics=off"));
  });
});

describe("scan.exec policy + availability", () => {
  const root = mkdtempSync(join(tmpdir(), "aice-scan-"));
  const runner = new ToolRunner(SCANNER_TOOLS);
  const call = (args) =>
    runner.call(
      { tool: "scan.exec", args, cwd: root, risk: "low", classification: "public" },
      {
        actor: "agent:tester", risk: "low", classification: "public",
        grant: GRANT, policyCtx: PCTX, jailRoot: root,
      },
    );

  it("unknown scanner → hard POLICY_DENIED (neverAllow), nothing spawned", async () => {
    const res = await call({ scanner: "fuzzball9000" });
    assert.equal(res.ok, false);
    assert.equal(res.code, "POLICY_DENIED");
  });

  const PATHS = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin".split(":");
  const present = (bin) => findOnPath(bin, PATHS) !== null;

  for (const id of ["gitleaks", "semgrep", "osv-scanner", "trivy"]) {
    it(`${id}: runs when installed, otherwise clean EXECUTION_FAILED`, async () => {
      const res = await call({ scanner: id, timeoutMs: 60_000 });
      const binName = id === "osv-scanner" ? "osv-scanner" : id;
      if (!present(binName)) {
        assert.equal(res.ok, false);
        assert.equal(res.code, "EXECUTION_FAILED");
        assert.match(res.output, /scanner not installed/);
      } else {
        // Installed: either a successful summary or a scan error — but never a crash;
        // and the structured channel is present on success.
        if (res.ok) {
          const d = res.data;
          assert.ok(d && typeof d === "object" && "findings" in d && "counts" in d);
        } else {
          assert.equal(res.code, "EXECUTION_FAILED");
        }
      }
    }, 90_000);
  }
});

describe("structured data channel (runtime)", () => {
  it("tools may return {text, data} — data surfaces on the result", async () => {
    const stubTool = {
      id: "t.structured",
      description: "stub",
      defaultRisk: "low",
      argsSchema: {},
      preflight: () => ({}),
      run: () => ({ text: "ok text", data: { findings: [1, 2, 3] } }),
    };
    const r = new ToolRunner([stubTool]);
    const root = mkdtempSync(join(tmpdir(), "aice-data-"));
    const res = await r.call(
      { tool: "t.structured", args: {}, cwd: root, risk: "low", classification: "public" },
      {
        actor: "agent:tester", risk: "low", classification: "public",
        grant: { ...GRANT, toolsAllow: ["t.structured"], terminal: "none" }, policyCtx: PCTX, jailRoot: root,
      },
    );
    assert.equal(res.ok, true);
    assert.match(res.output, /ok text/);
    assert.deepEqual(res.data, { findings: [1, 2, 3] });
  });
});
