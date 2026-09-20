# Codebase audit — 2026-09-20 (main vs frozen master plan)

**Scope**: everything in `main` at `0c7a774` (origin/main), compared clause-by-clause
against the frozen master spec `AI_Coding_Environment_End_to_End_Plan.md` (§1–§57).
**Method**: fresh clone verification (`git fetch --tags`), gate re-runs from scratch
(`npm ci` equivalent install), doc-vs-code drift walk, per-clause coverage matrix.
Prior audits: `codebase-audit-2026-09-17.md`, `codebase-audit-2026-09-18.md`.

---

## 1. Merge / commit state — what is actually in main

- `main` = `0c7a774` ("Merge pull request #4", 2026-09-19) — `git rev-parse main == origin/main`.
- Content identity: `main` = tag **`v1.0.2`** + PR #4 (native-shell preflight +
  execution plan + flake-triage runbook) — verified via `git diff v1.0.2 main` (4 files,
  all PR-#4 lanes, nothing else).
- Release tags all present on origin: `phase-0-complete` … `phase-9-complete`,
  `phase-10-hardening`, `phase-11-release-hardening`, `v1.0.0`, `v1.0.1`, `v1.0.2`
  (phase tags point at the pre-squash development history; `main` itself is a
  two-commit squashed train via PRs #2–#4 — all **MERGED**, none open).
- Working tree clean; nothing dangling uncommitted. **Conclusion: all authored work
  is merged and pushed. Nothing is missing from main relative to the development train.**

## 2. Fresh verification on the audit date (verbatim)

| Gate | Result |
|---|---|
| `npm test` (unit + security + integration) | **616 tests / 616 pass / 0 fail** (~85s) |
| `npm run lint` / `npm run typecheck` | exit 0 / exit 0 |
| `npm run security:gate` | **GREEN** — 5/5 lanes (secrets-scan, dep-audit 0 vulns, supply-chain R1–R4 15 manifests, SBOM CycloneDX 1.5 valid, SAST S1–S7 171 files) |
| `node scripts/migration-check.mjs` | GREEN — 5 additive migrations |
| `node scripts/a11y-check.mjs` | GREEN — rules **A1–A15**, 0 notes |
| `node scripts/release-check.mjs` | R1–R9 **PASS**; R10/R11 FAIL on a bare checkout **by design** (dist artifacts not pre-built — they are operator lanes that run after `release-prepare`/`release-sign`; publisher private key never on CI/clone) |

Environment: Node v22.22.3 (satisfies `engines >=22.18`).

## 3. Plan-clause coverage matrix (master spec §1–§57)

Legend: ✅ done + machine-proven · ◐ partially done / POC-scope · ⛔ deferred (owner
lane recorded in git). Deferred items all carry written owner lanes in
`docs/release/dod-review.md` / `project-state.md` — none are silent.

| Plan § | Clause | State | Evidence |
|---|---|---|---|
| §1–3 | Vision, positioning, design principles | ✅ | whole tree; principles machine-enforced (policy-first lanes) |
| §4/§31 | Desktop UX layout / UI screens | ◐ | 6-surface vanilla SPA POC (projects/workspace/context panels); full layout + command palette with native shell (⛔) |
| §5 | Projects & workspaces (isolated worktree model) | ✅ | `packages/orchestrator/workspace-service.ts`, git worktree lanes, workspace-isolation tests |
| §6 | Instructions hierarchy | ✅ | CLAUDE.md/AGENTS.md + policy precedence in `packages/policy` |
| §7/§8 | Agent roster + permission system | ✅ | `packages/agents` manifests + composer (investigate/plan/implement/review/fix), least-privilege grants |
| §9/§33 | Dangerous ops + approval model | ✅ | risk-gated approvals (plan/final), fail-closed engine guards, permission-bypass suite |
| §10/§12/§13 | Provider adapters, registry, router | ✅ (POC) | `packages/providers` — registry/router/dispatcher/budgets; script-replay + local-openai adapters; socket-level conformance harness (Ph.10); live-vendor runs ⛔ |
| §11 | API key management | ✅ (POC) | `packages/secrets` vault/keychain adapters, stdin-only set, redaction lanes |
| §14 | Multi-model collaboration | ✅ | deterministic classifier+router (escalation, debate/vote, tie→escalate) in `packages/context/routing.ts` |
| §15 | Context engine | ✅ | repo-index (symlink-safe), retrieval+budget, secret-path exclusion, CLI lanes |
| §16 | Prompt-injection defense | ✅/◐ | layered detectors incl. NFKC unicode canonical lane (Ph.10), trust labels, gates; model-backed multilingual detector ⛔ |
| §17 | MCP | ◐ | registry, deny-ladder gates, contained http/stdio client, abuse suites; OAuth-remote profile + marketplace ⛔ (fail-closed default) |
| §18 | Tool security | ✅ | every tool behind policy engine; argv-only terminal; redaction; audit |
| §19 | Sandboxing | ◐ | level-1 project jail + level-2 env scrub proven (sandbox-escape suite); level-3 disposable VM/container = detection + documented stance |
| §20 | Network security | ✅ | default-deny egress policy in dispatcher + SSRF rules + suite |
| §21 | Git safety | ✅ | checkpoint → worktree → rollback; merge-preview via `merge-tree` (Ph.11); argv-only runner |
| §22 | Testing pipeline | ✅/◐ | stack detect (.NET/Laravel/React/Python) + test-runner tool; Playwright browser E2E ⛔ |
| §23 | Security pipeline | ✅/◐ | offline blocking core (secrets, audit, SAST-lite, SBOM, supply-chain) + fuzz/red-team corpora; OSV/Semgrep/Trivy/ZAP as CI lanes ⛔ |
| §24 | Browser/UI testing | ◐ | `browser-fetch` tool w/ caps+redaction; isolated Playwright worker ⛔ |
| §25 | Agent memory | ◐ | `memory.read`/`memory.write` grants in agent manifests only; no memory store/retention/deletion/export subsystem yet — **smallest functional stub worth scheduling** |
| §26 | Audit system | ✅ | append-only, content-free, scoped; perf-probed |
| §27 | Auth & local security | ◐ | OS-credential adapters + encrypted vault; app passcode/session lock/idle timeout = native-shell lanes ⛔ |
| §28 | Desktop IPC security | ✅ | bridge kernel = the IPC surrogate: allowlist, strict arg schemas, `__proto__` rejection, host gate, CSP, no evidence self-attestation |
| §29 | Technical architecture (Tauri+React) | ⛔→◐ | ADR-001 settled target; divergence recorded with 3 sandbox probes; bridge-kernel continuity proven by Ph.10/11 lanes landing on it |
| §30 | Data storage | ✅ | SQLite WAL, 5 additive migrations, DAOs; FTS/vector not needed yet ("as appropriate") |
| §32 | Task state machine | ✅ | exact §32 vocabulary, engine-guarded transitions |
| §34/§35 | Model reliability + failover | ✅ | usage ledger, health, classification-aware ordered fallback |
| §36 | Data classification | ✅ | 4-level policy, restricted→local-only, project-scoping suite |
| §37 | Cost controls | ✅ | budget enforcer (pre/post dispatch), CLI lanes |
| §38/§39 | Offline mode + local models | ✅ | entire GA track is offline-executable; local-openai-compatible adapter |
| §40/§41 | Skills + plugins | ◐ | skills digest/tamper-blocked approvals, CLI lanes; `skills/` dir is a documented placeholder; plugin marketplace UI ⛔ |
| §42 | Updates | ◐ | ed25519 signed artifact chain + pinned pubkey (offline subset); binary signing + auto-update ⛔ |
| §43 | Telemetry | ✅ | default OFF — local usage ledger only |
| §44/§45 | Threat model + standards | ✅ | threat-model v2.0 (20 threats, F1–F7, 4 logged residuals) |
| §46 | Testing strategy | ✅ | 62 unit suites + 20 security files + 10 integration files |
| §47 | CI/CD | ◐ | `scripts/ci/ci.yml` template at parity (lint blocking, a11y, reproducibility) — **not installed to `.github/workflows/`** |
| §48/§49 | Repo structure + docs | ✅ | README in sync; 12 ADRs, 11 gate reviews, runbooks ×7, user guide |
| §50 | Phases 0–9 (+10, +11) | ✅ | all gate reviews passed, tagged |
| §51 | Definition of Done | ✅ (POC scope) | signed off in `docs/release/dod-review.md` |
| §52–§53 | Initial model strategy / first release target | ✅ (POC) | no hard-coded models; §53 golden workflow suite passes (diff → merge-preview → signing chain) |
| §54–§57 | Implementation order / rules / success criteria / next steps | ✅ | order followed; §55 non-negotiables machine-enforced; §57 checklist complete |

**Coverage**: every clause is ✅/◐/⛔ — nothing untracked, nothing silently dropped
(the freeze contract is honored: all removals went through ADRs/deferral lanes).

## 4. Drift found by this audit — all fixed in branch `arena/01a0bd4f-ai-coding-environment`

| # | Drift | Fix |
|---|---|---|
| D1 | `packages/security/package.json` still **0.3.0** (1.0.0 bump missed one of 15 manifests; lockfile already had 1.0.2 → `npm install` rewrote lock to 0.3.0) | → **1.0.2** (commit `5afa9ed`) |
| D2 | `aice version` banner printed **0.6.0-phase6** | → prints **1.0.2** (commit `7c5de24`) |
| D3 | `docs/release/release-checklist.md` stale: header v0.6.x; R6 said A1–A9 (gate enforces A1–A15); missing **R11** signature row (present in `release-check.mjs` since v1.0.0); tag/sign sequence pre-v1.0.0 | header v1.0.x, A1–A15, R11 row added, sign+verify sequence documented |
| D4 | README said a11y A1–A13 (A14/A15 landed in v1.0.2 per CHANGELOG) | → A1–A15 |

**Fixture-hygiene note (discovered, by design, now documented):**
`tests/security/security-gate.test.mjs` mutates `packages/security/package.json`
for its supply-chain R1 probe and restores it with
`git checkout -- packages/security/package.json` — i.e., to **HEAD**, not to the
pre-test working-tree content (HEAD-purity discipline from the v1.0.1 R11-drift
follow-through). Practical rule: **never run `npm test` with uncommitted edits to
that file** — the suite silently reverts them. Commit first, then the restore lane
returns the committed (fixed) bytes. Verified: with D1 committed, a full suite run
leaves the tree clean and `packages/security` at 1.0.2.

## 5. What is NOT in main (deferred — each with an owner lane)

1. **Tauri 2.x native shell + React port** (ADR-001 final form) — environment-blocked
   in the build sandbox (3 recorded probes: no rust toolchain, no webkit2gtk, no rustup
   reachability). Bridge kernel is the durable contract; continuity re-proven by
   Ph.10/11 lanes landing on it.
2. **Binary code-signing + auto-update + OS tray/notifications/shortcuts** — natives
   of the shell lane.
3. **Live-vendor provider conformance** (real OpenAI/Anthropic/NVIDIA/Gemini API runs)
   — socket-level harness per protocol already green; credentialled runs are operator-side.
4. **MCP OAuth/remote servers + plugin/skill marketplace UI** — remote profile intentionally
   fail-closed today (safe default).
5. **Model-backed multilingual injection detector + unicode-steganography hygiene class** —
   threat-model residuals #1–#3; regex + NFKC canonical lane + policy gating is the
   documented boundary.
6. **Installed CI** (`.github/workflows/`) with OSV-Scanner/Semgrep/Trivy/ZAP lanes and
   SHA-pinned actions — template at `scripts/ci/ci.yml` is at parity and waiting on
   CI-install; offline blocking core runs today.
7. **Runtime AT (screen-reader) a11y pass** + DOM-level SPA test runner — shell-lane items.
8. **Agent memory subsystem** (§25) — grants exist; no store/retention/deletion/export yet.
9. **Playwright isolated browser worker** (§24 full form) — fetch-tool covers the POC lane.
10. **Level-3 disposable VM/container sandbox** (§19) — detection + documented posture today.

## 6. Ordered next steps (path to the packaged product)

1. **Land this audit's drift fixes** (PR from `arena/01a0bd4f-ai-coding-environment`),
   then run the §53 golden workflow manually once and sign the checklist attestations.
2. **Install CI**: copy `scripts/ci/ci.yml` → `.github/workflows/ci.yml`, add
   OSV-Scanner/Semgrep/Trivy/ZAP actions (SHA-pinned), wire `release-check` as the
   release gate. Closes deferral #6 and deepens #5's supply-chain assurance.
3. **Agent memory v1** (§25): `packages/memory` — store behind policy, per-project
   scoping (T20), retention/visibility/deletion/export + audit events. Small, self-contained.
4. **Native shell spike** on a machine with Rust: scaffold Tauri 2.x over the bridge
   kernel unchanged (`apps/desktop/src/server.ts` is already env-agnostic); prove the
   kernel under Tauri IPC; then React port inside the packaged track (dependency-policy
   v2 allows it there, not in the zero-runtime-dep kernel track).
5. **Binary signing + auto-update + tray** once the shell exists ( publisher-key
   runbook already covers rotation).
6. **Live-vendor conformance matrix** against real provider APIs with operator
   credentials; record results in a conformance report doc.
7. **MCP OAuth-remote profile + marketplace UI** (ADR-005 spec-compliant auth).
8. **Model-backed multilingual detector + unicode-steganography red-team corpus**.
9. **Playwright browser worker + AT a11y pass + DOM SPA test runner** (UI depth batch).
10. **Release housekeeping**: cut `v1.0.3` tag after step 1 lands (CHANGELOG train).

## 7. Bottom line

Main is **complete, green, signed and reproducible for the local-first governed track
(v1.0.2, 616 tests)** — every frozen-plan clause is either machine-proven done, POC-scoped
with a written boundary, or deferred with an owner lane. The only defects found by this
audit were four lines of version/doc drift (fixed in the sibling branch) plus one test
fixture-hygiene hazard (documented). The remaining plan delta is product packaging
(native shell and its derived lanes), credentialled/live lanes, and detector depth —
scheduled engineering, not unknowns.
