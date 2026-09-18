#!/usr/bin/env node
// Supply-chain policy check (P8.6): mechanical enforcement of docs/security/dependency-policy.md.
//   R1  runtime "dependencies", optionalDependencies, peerDependencies must be EMPTY in
//       every workspace package (governed environment: zero runtime deps)
//   R2  devDependencies entries are EXACT pins (no ^, ~, *, latest, git+, file:, http)
//       — with the single exception of workspace-links ("*") under workspaces
//   R3  no preinstall/install/postinstall/prepare scripts anywhere (hooks execute code)
//   R4  root package-lock.json exists, lockfileVersion 3, no http: registry URLs
// All violations are FAIL (exit 1) with named evidence — no silent fallbacks.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const violations = [];
const checks = [];

function readJson(rel) {
  return JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
}

function* workspaceManifests() {
  const root = readJson("package.json");
  for (const pattern of root.workspaces ?? []) {
    const base = pattern.replace(/\*+\/?/, "");
    const dir = join(ROOT, base);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const pkg = join(base, entry.name, "package.json");
      if (entry.isDirectory() && existsSync(join(ROOT, pkg))) yield pkg;
    }
  }
  yield "package.json";
}

// R1 + R2 + R3 per manifest
const HOOK_RE = /^(pre|post)?install$|^prepare$/;
const FORBIDDEN_SPEC_RE = /^(\^|~|\*|latest$|git\+|git:|file:|link:|https?:)/;
for (const rel of workspaceManifests()) {
  const manifest = readJson(rel);
  // R1
  for (const lane of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    const entries = Object.entries(manifest[lane] ?? {});
    if (entries.length > 0) {
      violations.push(`R1 [${rel}] runtime ${lane} must be empty — found: ${entries.map(([k, v]) => `${k}@${v}`).join(", ")}`);
    }
  }
  // R2: exact dev pins (allow "*" only for workspace-internal links listed in workspaces)
  for (const [name, spec] of Object.entries(manifest.devDependencies ?? {})) {
    if (FORBIDDEN_SPEC_RE.test(spec)) {
      violations.push(`R2 [${rel}] devDependency "${name}@${spec}" is not an exact pin`);
    }
  }
  // R3
  for (const script of Object.keys(manifest.scripts ?? {})) {
    if (HOOK_RE.test(script)) {
      violations.push(`R3 [${rel}] install hook script forbidden: "${script}"`);
    }
  }
  checks.push(rel);
}

// R4: lockfile shape
const lockRel = join(ROOT, "package-lock.json");
if (!existsSync(lockRel)) {
  violations.push("R4 package-lock.json missing (lock-pinned reproducibility required)");
} else {
  const lock = JSON.parse(readFileSync(lockRel, "utf8"));
  if (lock.lockfileVersion !== 3) violations.push(`R4 lockfileVersion must be 3 (got ${lock.lockfileVersion})`);
  const body = readFileSync(lockRel, "utf8");
  if (/"resolved"\s*:\s*"http:\/\//.test(body)) violations.push("R4 lockfile contains insecure http:// registry URLs");
  // workspace-link entries must not carry a runtime dependency closure
  const pkgs = Object.entries(lock.packages ?? {});
  const wsRuntime = pkgs.filter(([path, meta]) => (path.startsWith("packages/") || path.startsWith("apps/")) && Object.keys(meta.dependencies ?? {}).length > 0);
  if (wsRuntime.length > 0) {
    violations.push(`R4 lockfile records runtime deps in workspace packages: ${wsRuntime.map(([p]) => p).join(", ")}`);
  }
}

console.log(`# supply-chain check — ${checks.length} manifests, rules R1-R4`);
if (violations.length > 0) {
  for (const v of violations) console.log(`VIOLATION  ${v}`);
  console.error(`SUPPLY-CHAIN: FAIL (${violations.length} violation(s))`);
  process.exit(1);
}
console.log(`SUPPLY-CHAIN: GREEN (${checks.length} manifests clean, lock v3, zero runtime deps)`);
