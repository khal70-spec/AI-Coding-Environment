#!/usr/bin/env node
// SBOM verify lane (security-gate lane 5): regenerate the SBOM deterministically
// to a tmp file and validate it — CycloneDX skeleton, component coverage, zero
// runtime-lane components (cross-checks supply-chain R1 through the lockfile).
// Exit 0 + one summary line on success; exit 1 with specific failures otherwise.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "../..");
const work = mkdtempSync(join(tmpdir(), "aice-sbom-check-"));
const failures = [];
try {
  execFileSync(process.execPath, ["scripts/sbom-generate.mjs", "--out", join(work, "sbom.json")], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  const bom = JSON.parse(readFileSync(join(work, "sbom.json"), "utf8"));
  if (bom.bomFormat !== "CycloneDX" || bom.specVersion !== "1.5") failures.push("wrong bomFormat/specVersion");
  if (!Array.isArray(bom.components) || bom.components.length < 100) failures.push(`suspicious component count: ${bom.components?.length}`);
  const runtime = (bom.components ?? []).filter((c) => c.properties?.some((p) => p.name === "cdx:npm:development" && p.value === "false"));
  if (runtime.length !== 0) failures.push(`${runtime.length} runtime-lane components (policy violation)`);
  const ws = (bom.components ?? []).filter((c) => c.properties?.some((p) => p.name === "workspace:path"));
  if (ws.length < 13) failures.push(`only ${ws.length} workspace components (expected ≥13)`);
} catch (e) {
  failures.push(`generator failed: ${e.message?.slice(0, 200)}`);
} finally { rmSync(work, { recursive: true, force: true }); }

if (failures.length !== 0) {
  for (const f of failures) console.error(`SBOM-CHECK: FAIL — ${f}`);
  process.exit(1);
}
console.error("SBOM-CHECK: GREEN (CycloneDX 1.5 valid, ≥13 workspace components, 0 runtime-lane)");
