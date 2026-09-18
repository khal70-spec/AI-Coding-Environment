#!/usr/bin/env node
// release-check (P9.6): the mechanical release-readiness matrix (Plan §50/51).
// Runs every blocking gate + readiness lane in order and prints a PASS/FAIL line per
// row; exit 1 unless ALL rows pass. This is the sign-off command for release tags.
// Matrix rows map 1:1 to docs/release/release-checklist.md — no row gets skipped.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NODE = process.execPath;

const rows = [
  { id: "R1", lane: "unit+integration+security tests green", cmd: ["npm", ["test"]], timeout: 900_000 },
  { id: "R2", lane: "typecheck (tsc --noEmit)", cmd: ["./node_modules/.bin/tsc", ["--noEmit", "-p", "tsconfig.base.json"]], timeout: 240_000 },
  { id: "R3", lane: "lint (eslint all lanes)", cmd: ["npm", ["run", "lint"]], timeout: 300_000 },
  { id: "R4", lane: "security gate (secrets/audit/supply-chain/SAST)", cmd: [NODE, [join("scripts", "security-gate.mjs")]], timeout: 300_000 },
  { id: "R5", lane: "migrations additive-only + well-formed", cmd: [NODE, [join("scripts", "migration-check.mjs")]], timeout: 60_000 },
  { id: "R6", lane: "a11y static gate (desktop web)", cmd: [NODE, [join("scripts", "a11y-check.mjs")]], timeout: 60_000 },
  { id: "R7", lane: "docs: gate reviews for all phases present", check: () => {
      const missing = [];
      for (const ph of ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]) {
        const p = join(ROOT, "docs", "development", `phase-${ph}-gate-review.md`);
        if (!existsSync(p)) missing.push(`phase-${ph}`);
      }
      if (missing.length > 0) return { ok: false, detail: `missing: ${missing.join(", ")}` };
      return { ok: true, detail: "10/10 gate reviews present" };
    } },
  { id: "R8", lane: "docs: runbooks + upgrade + release docs present", check: () => {
      const need = [
        "docs/runbooks/backup-restore.md",
        "docs/runbooks/crash-recovery.md",
        "docs/runbooks/upgrade.md",
        "docs/release/release-checklist.md",
        "docs/release/dod-review.md",
      ];
      const missing = need.filter((p) => !existsSync(join(ROOT, p)));
      if (missing.length > 0) return { ok: false, detail: `missing: ${missing.join(", ")}` };
      return { ok: true, detail: `${need.length} documents present` };
    } },
  { id: "R9", lane: "no tracked placeholder markers in shipped code (task-market tags)", check: () => {
      const lanes = ["packages", "apps", "scripts"];
      const r = spawnSync("git", ["grep", "-n", "-i", "-E", "\\b(TODO|FIXME|XXX|HACK):", "--", ...lanes], { cwd: ROOT, encoding: "utf8", shell: false });
      if (r.status === 1) return { ok: true, detail: "no placeholders in shipped lanes" };
      if (r.status !== 0) return { ok: false, detail: `git grep failed: ${r.stderr.slice(0, 200)}` };
      const hits = r.stdout.trim().split("\n").filter((l) => l !== "");
      return hits.length === 0
        ? { ok: true, detail: "no placeholders in shipped lanes" }
        : { ok: false, detail: `${hits.length} placeholder(s):\n${hits.slice(0, 5).map((h) => `  ${h.slice(0, 160)}`).join("\n")}` };
    } },
  { id: "R10", lane: "release artifact sums + reproducibility (dist pre-built)", cmd: [NODE, [join("scripts", "release-verify.mjs")]], timeout: 120_000 },
];

console.log(`# Release readiness matrix — ${rows.length} rows (ALL must pass)`);
let failed = 0;
for (const row of rows) {
  const t0 = Date.now();
  let ok;
  let detail;
  if (row.check !== undefined) {
    const res = row.check();
    ok = res.ok;
    detail = res.detail ?? "";
  } else {
    const [cmd, args] = row.cmd;
    const res = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", shell: false, timeout: row.timeout });
    ok = res.status === 0;
    const lines = (`${res.stdout ?? ""}\n${res.stderr ?? ""}`).split("\n").filter((l) => l.trim() !== "");
    detail = ok ? lines.slice(-1).join("").slice(0, 140) : lines.slice(-3).join(" | ").slice(0, 300);
  }
  const ms = Date.now() - t0;
  console.log(`${ok ? "PASS" : "FAIL"} ${row.id} ${row.lane}`);
  console.log(`${ok ? "    " : "  !!"} ${detail}  (${ms}ms)`);
  if (!ok) failed++;
}
if (failed > 0) {
  console.error(`RELEASE-CHECK: FAIL (${failed}/${rows.length} rows failed)`);
  process.exit(1);
}
console.log(`RELEASE-CHECK: GREEN (${rows.length}/${rows.length} rows)`);
