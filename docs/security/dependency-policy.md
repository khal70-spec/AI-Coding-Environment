# Dependency Policy (Plan §44-T7, §47)

## Rules

1. **Minimal surface**: prefer `node:` builtins. Each new dependency needs a stated reason
   in the PR (what it does, why builtins don't suffice, maintenance/health check).
2. **Pinned + locked**: exact versions in `package.json`, committed lockfile (`npm-shrinkwrap`
   or `package-lock.json`) from Phase 1 onward. No floating ranges for security-sensitive libs.
3. **Gates on every PR**: `npm audit --audit-level=high` and the offline secret scan are
   blocking from Phase 0; the CI workflow is authored at `scripts/ci/ci.yml`
   (upgraded 2026-09-20 with SHA-pinned actions and blocking OSV-Scanner/Semgrep/
   Trivy lanes; maintainer-token install pending — history in `scripts/ci/README.md`).
   SBOM generation runs offline via `tools:sbom` + the gate's sbom-manifest lane.
4. **No pre/postinstall scripts** from third-party packages unless reviewed and pinned;
   set `ignore-scripts` where practical and allowlist explicitly.
5. **SBOM**: generated from Phase 8 (`source → test → security → signed build → verify → release`).
6. **Telemetry/system-access packages** (network, fs, process, keychain, update frameworks)
   require an ADR and permission review.
7. **Vulnerability response**: critical/high → fix or documented exception within the PR;
   exceptions need owner + expiry + residual risk note.

## Dependency set (current)

**Runtime dependencies: zero** — deliberate and enforced by review; security kernels stay
dependency-free. **Dev dependencies (Phase 1+)**: `typescript@5.9.3`, `@types/node@22.20.3`
(both exact-pinned, lockfile committed) for the blocking `npm run typecheck` gate.
ESLint + `typescript-eslint` join as dev-deps with the Phase 3 config wave.

## Mechanical enforcement (Phase 8, v2)

The rules above are no longer review-checklist-only — they are machine-checked and BLOCKING:

- `scripts/supply-chain-check.mjs` (lane 3 of `npm run security:gate`) enforces rules
  R1–R4: zero runtime/optional/peer deps in every workspace package, exact dev pins
  (no `^`/`~`/latest/git/file), zero install-hook scripts anywhere, lockfile v3 with no
  insecure `http://` registry URLs and no runtime-dep closure inside workspace entries.
- `scripts/security-gate.mjs` composes the blocking lanes: secrets scan →
  `npm audit --audit-level=high --production` → supply-chain → SAST-lite. Any lane
  failing exits 1 with the lane + evidence named (fail-loud proof:
  `tests/security/security-gate.test.mjs` plants a real violation per lane).
- `scripts/security-sast.mjs` (S1–S7): forbidden-API classes (eval/new Function,
  `shell: true`, direct shell spawn, SQL template interpolation, uncontrolled
  `process.env` reads in packages, renderer XSS sinks, CORS wildcard) with a
  visible allowlist (every suppression prints its reason at scan time).
- Root `.npmrc` posture: `ignore-scripts=true` recommended for third-party install
  surfaces (workspace setup uses exact-pinned dev deps only).
