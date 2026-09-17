# Dependency Policy (Plan §44-T7, §47)

## Rules

1. **Minimal surface**: prefer `node:` builtins. Each new dependency needs a stated reason
   in the PR (what it does, why builtins don't suffice, maintenance/health check).
2. **Pinned + locked**: exact versions in `package.json`, committed lockfile (`npm-shrinkwrap`
   or `package-lock.json`) from Phase 1 onward. No floating ranges for security-sensitive libs.
3. **Gates on every PR**: `npm audit --audit-level=high` and the offline secret scan are
   blocking from Phase 0 (workflow authored at `scripts/ci/ci.yml`, pending install —
   run locally until then). OSV-Scanner and Semgrep
   `p/security-audit` are introduced as advisory jobs in Phase 3 and become blocking in
   Phase 8; SBOM generation and SHA-pinned workflow actions land in Phase 8 too.
4. **No pre/postinstall scripts** from third-party packages unless reviewed and pinned;
   set `ignore-scripts` where practical and allowlist explicitly.
5. **SBOM**: generated from Phase 8 (`source → test → security → signed build → verify → release`).
6. **Telemetry/system-access packages** (network, fs, process, keychain, update frameworks)
   require an ADR and permission review.
7. **Vulnerability response**: critical/high → fix or documented exception within the PR;
   exceptions need owner + expiry + residual risk note.

## Phase 0 dependency set

Zero runtime dependencies. Dev/test use only `node --test` + TypeScript (added Phase 1).
This keeps the foundation auditable while the policy engine, redaction, and state
machine are built on pure, easily-reviewed logic.
