#!/usr/bin/env node
// BLOCKING security gate (P8.1, Plan §50): secrets scan → dependency audit →
// supply-chain policy → SAST-lite. Every lane must pass; any non-zero lane fails the
// whole gate with a named summary (fail-loud — exit codes never swallowed).
// Usage: node scripts/security-gate.mjs   (exit 0 = green, 1 = violation, 2 = gate broke)
import { spawnSync } from "node:child_process";
import { execPath } from "node:process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Run a lane; failures (non-zero) mark the gate. STDERR lanes that crash exit 2. */
function runLane(name, command, args, opts = {}) {
  const started = Date.now();
  const res = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, NPM_CONFIG_AUDIT_LEVEL: "high", ...(opts.env ?? {}) },
    shell: false, // argv-only, always
    timeout: opts.timeout ?? 180_000,
  });
  const ms = Date.now() - started;
  if (res.error !== undefined) {
    return { name, status: "ERROR", ms, note: res.error.message };
  }
  const ok = res.status === 0;
  const lines = (`${res.stdout ?? ""}\n${res.stderr ?? ""}`).split("\n").filter((l) => l.trim() !== "");
  return { name, status: ok ? "PASS" : "FAIL", ms, note: lines.slice(-3).join(" | ").slice(0, 500), tail: lines.slice(-8) };
}

const results = [];
console.log("# Security gate (Plan §50) — 4/4 lanes must pass");
results.push(runLane("secrets-scan", execPath, [join("scripts", "check-secrets.mjs")]));
results.push(runLane("dependency-audit", "npm", ["audit", "--audit-level=high", "--production"], { timeout: 240_000 }));
results.push(runLane("supply-chain", execPath, [join("scripts", "supply-chain-check.mjs")]));
results.push(runLane("sast-lite", execPath, [join("scripts", "security-sast.mjs")]));

let hardFail = false;
for (const r of results) {
  const icon = r.status === "PASS" ? "✓" : r.status === "FAIL" ? "✗" : "!";
  console.log(`${icon} ${r.name.padEnd(18)} ${r.status.padEnd(5)} ${String(r.ms).padStart(5)}ms  ${r.note}`);
  if (r.status !== "PASS") {
    hardFail = true;
    for (const l of r.tail ?? []) console.log(`    | ${l.slice(0, 200)}`);
  }
}
if (hardFail) {
  console.error("SECURITY GATE: FAIL — see lanes above");
  process.exit(1);
}
console.log("SECURITY GATE: GREEN");
