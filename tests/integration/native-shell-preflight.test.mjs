// Native-shell trunk: preflight lane is executable + honest. Verdict in THIS sandbox
// must be BLOCKED (recorded datapoint) — the day it flips READY, the execution plan unlocks.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const REPORT = join(root, "dist/native-shell-preflight.json");

test("preflight: report written + structurally honest, today's env verdict recorded", () => {
  rmSync(REPORT, { force: true });
  const r = spawnSync(process.execPath, ["scripts/native-shell-preflight.mjs"], { cwd: root, encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /NATIVE-SHELL-PREFLIGHT: (READY|BLOCKED)/);
  assert.ok(existsSync(REPORT));
  const report = JSON.parse(readFileSync(REPORT, "utf8"));
  assert.equal(typeof report.ready, "boolean");
  assert.ok(Array.isArray(report.checks) && report.checks.length === 5);
  for (const c of report.checks) {
    assert.equal(typeof c.ok, "boolean");
    assert.ok(typeof c.name === "string" && typeof c.lane === "string");
  }
  // current sandbox reality (uid 1001, no toolchain): must be BLOCKED.
  assert.equal(report.ready, false);
  assert.ok(report.checks.filter((c) => !c.ok).length >= 1);
});

test("preflight: --require-ready exits 1 while blocked (implements the fail-closed gate)", () => {
  const r = spawnSync(process.execPath, ["scripts/native-shell-preflight.mjs", "--require-ready"], { cwd: root, encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /BLOCKED/);
});
