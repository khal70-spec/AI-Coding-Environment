# Definition-of-Done review — Phase 10 release sign-off (Plan §50/51)

**Verdict: DONE for the poc-scope release (local-first, offline-governed build).**
The review is criterion-by-criterion with machine evidence paths. Deferred product
surfaces are listed last — each has a tracked owner lane.

## Core DoD criteria (Plan §50)

| Criterion | Status | Evidence |
|---|---|---|
| Every plan task implemented or explicitly deferred | ✅ | `docs/backlog/` phase files + `phases-1-9.md` all ticked; 10 gate reviews (R7) |
| All tests green, deterministic, fail-loud | ✅ | `npm test` = the required gate; seeded fuzz suites replay via `FUZZ_SEED`; runner non-zero exit kills CI (no swallowed pipes) |
| No silent fallbacks / placebo lanes | ✅ | S1–S7 SAST + supply-chain R1–R4 + explicit `fail closed` design; success requires demanded effect (e2e suites prove real effects in DB/filesystem, not mocks) |
| Repo mandate: anti-cheat compliance | ✅ | Security docs + gate lanes + every close-out carries verbatim evidence lines (`docs/development/phase-*-gate-review.md`) |
| Secrets never in repo/logs/db | ✅ | `check-secrets` blocking + SAST S5 + redaction lanes + secrets service deliveries (Phase 2) |
| Migrations additive-only, idempotent | ✅ | `scripts/migration-check.mjs` M1–M4 + `backup-restore.test.mjs` §3 |
| Security posture: threat model current, residual risks logged | ✅ | `docs/security/threat-model.md` v2.0 (F1–F7 findings + 4 residual risks) |
| Supply chain: zero runtime deps, exact pins, no hooks | ✅ | `scripts/supply-chain-check.mjs` (lane of the blocking security gate) |
| UI cannot self-attest governance evidence | ✅ | Phase 7 e2e: evidence commands don't exist on the bridge; engine re-validates |
| Backup/restore/crash recovery operator-ready | ✅ | `docs/runbooks/*` + `crash-recovery.test.mjs` + `backup-restore.test.mjs` |
| Release artifact deterministic + verifiable | ✅ | `release-prepare`/`release-verify` (byte-identical rebuild from HEAD) |
| Perf: no pathological hot paths | ✅ | `perf-budgets.test.mjs` (audit bulk 13.7ms/1000 rows, bridge median 1.48ms, CLI ~230ms) |
| Docs complete (§49): guides, runbooks, policies, ADRs, backlogs | ✅ | `docs/` tree: user-guide, runbooks (3), security (5), adr (10), architecture (3), release (2), backlog |

## Known deferrals (post-release lanes)

1. **Tauri shell + React port** (ADR-001 final form) — bridge kernel reusable as-is (Phase 7 gate review documents the divergence; the kernel is the durable contract).
2. **Code-signing identity + auto-update** — blocked on the native shell (signed artifact identity is meaningless for a source-attested tarball; the reproducibility lane covers tamper-evidence by hash).
3. **OSV-Scanner / Semgrep / SBOM generation / SHA-pinned CI actions** — dependency-policy v2 carries these as CI-side jobs; the offline blocking core (audit + supply-chain R1-R4 + secrets + SAST) runs today.
4. **Model-backed injection detector (multilingual/leetspeak)** — threat-model residual #1/#2; current regex lane + policy gating is the documented boundary.
5. **MCP OAuth for remote servers + plugin marketplace UI** — Ph.6 gate review deferrals; remote profile unshipped is fail-closed by default.
6. **Runtime AT (assistive-technology) a11y testing** — static gate covers structure only (a11y-check.mjs limitation, recorded as NOTE at scan time).
7. **Provider live-transport conformance matrix** — script-replay/local-openai lanes tested; live vendor conformance suite is provider-config work on the operator side.

## Sign-off

- Release checklist matrix: `node scripts/release-check.mjs` → all rows PASS (see
  `docs/development/phase-9-gate-review.md` for the verbatim run evidence).
- Owner lanes for each deferral: recorded above and in the relevant phase gate review.
