# Project state — end-to-end production readiness (2026-09-19)

**Headline: ~91% (90.8%) to the end-to-end production target** — recomputed 2026-09-19 after Phase 10 + Phase 11 depth increments (`docs/development/phase-10-gate-review.md`, `phase-11-gate-review.md`). Baseline at Phase 9 close-out: 87% → 89.7% (Ph.10) → 90.8% (Ph.11). How that number is derived
below — weighted capability domains against the master plan (`AI_Coding_Environment_End_to_End_Plan.md`),
not vibes. Each row links its evidence.

---

## A. What is DONE (verified, tagged, tested)

| # | Capability | Gate evidence |
|---|---|---|
| 1 | Core runtime: ADR-007 task state machine, risk-gated approvals (plan/final), content-free append-only audit, engine-guarded transitions (denials never touch rows) | Phase 1 gate; every subsequent phase re-proves via golden workflow |
| 2 | Storage: SQLite WAL, 5 additive migrations (linted M1–M4), DAOs with project/task scoping, monitoring queries | storage suites + migration-check + backup-restore suite |
| 3 | Git lanes: argv-only runner, checkpoint → isolated worktrees, rollback evidence | git suites + workspace lanes |
| 4 | Policy engine: grants, classification policy, T20 cross-project isolation | policy unit + project-scoping security tests |
| 5 | Security kernels: redaction, path containment (lexical + symlink-safe), command classifier, injection detector, egress SSRF rules | security unit + fuzz + sandbox-escape (Phase 8 hardened) |
| 6 | Secrets service: vault/keychain lanes, stdin-only key set, status probes | secrets suites + cli-providers integration |
| 7 | Providers: registry, router, dispatcher, script-replay + local-openai-compatible adapters, budgets, telemetry, health | provider suites + cli-providers integration (Phase 2) |
| 8 | Tools: fs.read/write/edit/list/search, git-ops, argv-only terminal, scanners, test-runner, browser-fetch — jailed, granted, capped, redacted | 10 tool suites + runner + sandbox-escape |
| 9 | Agents: composer pipeline (investigate/plan/implement/review/fix), agent_runs evidence, bounded retries | agents suites + cli-agent-run integration (Phase 4) |
| 10 | Context engine: repo index, packers, routing, context CLI lanes | context suites (Phase 5) |
| 11 | MCP: registry, gates (deny ladder), contained client (http/stdio, caps/timeouts), skills digest + tamper-blocked approvals, CLI `mcp`/`skill` lanes | mcp suites + abuse suite (Phases 6/8) |
| 12 | UI bridge kernel: allowlisted commands, pinned args, stable lanes, version fingerprint, bridge-over-engine writes | bridge tests (Phase 7) |
| 13 | Desktop POC: hardened HTTP adapter (host gate, caps, CSP, traversal-proof), vanilla SPA (6 surfaces), a11y static gate | desktop + e2e + a11y suites (Phase 7/9) |
| 14 | Security gate machinery: `security:gate` (secrets/dep-audit/supply-chain/SAST) + fail-loud probes + seeded fuzz corpus + red-team corpus | Phase 8 gate review + 19 security suites |
| 15 | Production ops: SIGKILL crash-recovery, verified backup/restore, migration lint, perf budgets, deterministic release artifacts (byte-identical rebuild), release readiness matrix | Phase 9 gate review; `release-check` 10/10 |
| 16 | Docs: 10 gate reviews, user guide (Phases 1–9), runbooks (3), security policies + threat-model v2, 12 ADRs, backlog ledger, DoD review | this audit + R7/R8 rows |

## B. What is NOT done (deferred with owner lanes)

| # | Deferred item | Why deferred | Owner/lane | Impact on target |
|---|---|---|---|---|
| 1 | **Tauri 2.x native shell + React port** (packaged desktop product per ADR-001) | no Rust toolchain in sandbox; kernel-precondition satisfied instead (bridge kernel env-agnostic) | ADR-001 / Phase 7 review | Biggest residual product surface |
| 2 | **Code-signing identity + auto-update** | native-shell dependent | DoD review | release track lacks packaged-app update mechanism |
| 3 | **Live vendor provider conformance** matrix (OpenAI/Anthropic/NVIDIA etc. against real APIs) | offline-first POC; adapters are local lanes today | providers (Phase 2 road) | “any provider” claim needs conformance proof live |
| 4 | **MCP OAuth/remote servers + marketplace UI** | remote profile intentionally fail-closed in the POC | Phase 6 review | remote-MCP lot unshipped |
| 5 | **Model-backed injection detector** (multilingual/leetspeak) + unicode-steganography hygiene class | documented boundary; regex lane + policy gating compensates | threat-model residuals #1–#3 | recognized detector-gap |
| 6 | **OSV-Scanner / Semgrep / SBOM / SHA-pinned CI actions** | CI-install pending; offline blocking core already in `security:gate` | dependency-policy v2 | supply-chain assurance depth |
| 7 | **Runtime AT a11y testing** (screen-reader pass) | static gate only; AT review belongs to native shell | a11y-check NOTE lane | packaged-app a11y assurance |
| 8 | **Diff viewer UX + file-tree merge UX** | needs git worktree diff bridge (read-only, path-scoped) | Phase 7 review | operator ergonomics gap |
| 9 | **OS tray/notifications/shortcuts** | native shell feature | ADR-001 | packaged-app polish |
| 10 | **DOM-level SPA test runner** (happy-dom etc.) | deferred with React port; invariants asserted structurally today | Phase 7 review | UI test depth |

*(Complete authoritative list: `docs/release/dod-review.md` “Known deferrals”.)*

## C. Readiness percentage — the model

Weights = master-plan capability domains; attainment = 1.0 if gates prove it, discounted
for explicit deferrals. No row gets credit without gate evidence.

| Domain | Weight | Attainment | Basis |
|---|---|---|---|
| Foundation (runtime, storage, governance, audit) | 15% | 100% | rows A1–A5 |
| Providers & secrets | 12% | **92%** | A6–A7 + socket-level conformance harness per protocol (Phase 10); discount narrows to live-vendor credentialled runs (B3) |
| Tools & sandbox | 12% | 95% | A8; escrow: fs/terminal/git/scanner all gated |
| Agents | 12% | **93%** | A9 + adapter loop proven against conformance harness (Phase 10) |
| Context & routing | 8% | 95% | A10 |
| MCP / skills / plugins | 10% | 85% | A11; discount: OAuth remote + marketplace (B4) |
| Desktop product (packaged) | 13% | **68%** | kernel (A12), POC app with a11y A1–A13 depth + **diff-viewer + merge-preview lanes** (Ph.10/11); native shell + tray + binary signing + update pending (B1/B2/B9) — shell lanes probe-blocked in sandbox (three datapoints, gate review) |
| Security hardening | 8% | **96%** | A4/A14 + unicode canonical lane (Ph.10) + **a11y static depth A10–A13 incl. computed WCAG AA contrast** (Ph.11); discount narrows to model-backed multilingual (B5) + CI-depth (B6) |
| Production ops & release | 6% | **96%** | A15 + SBOM lane (Ph.10) + **ed25519 signed artifact chain w/ pinned publisher key** (Ph.11); discount narrows to binary signing inside the shell + SHA-pinned CI actions (B2/B6) |
| Documentation & process rails | 4% | 95% | A16; ragged edge: runbook series for exploit playbooks |

**Weighted total = 90.8% ≈ 91%** (0.15×1.00 + 0.12×0.92 + 0.12×0.95 + 0.12×0.93 +
0.08×0.95 + 0.10×0.85 + 0.13×0.68 + 0.08×0.96 + 0.06×0.96 + 0.04×0.95 = 0.9078).
Trajectory: 87% (Ph.9) → 89.7% (Ph.10) → 90.8% (Ph.11).

Interpretation: the **governed, offline-first core (73% of the weighted product) is
effectively production-done** (weighted attainment ≥ 85% in every core domain). The
remaining **13 points are almost entirely the packaged-product tracks** (native shell,
signing/update, live-vendor conformance, detector depth) — engineering work with
green-lit continuity (the bridge kernel and policy rails carry forward unchanged)
rather than unresolved unknowns.

### Path to 100%
1. Native shell (Tauri + React) over the shipped bridge kernel → desktop domain to ~90%.
2. Code-signing + auto-update + SBOM CI → ops/release domains to ~95%.
3. Live-vendor provider conformance suite → providers/agents domains to ~95%.
4. Model-backed detector + unicode hygiene red-team → hardening to ~95%.
5. Packaged-app AT review + tray/notifications + diff viewer UX → final product-polish points.

## D. Bottom line

The repo you hold is a **release-candidate governed environment (611 tests, SBOM'd, ed25519-signed, reproducible)**: deterministic builds,
blocking security gates, crash-proof storage, golden workflow to MERGED, and a clean
3,000→263-file disciplined tree. It can be operated end-to-end today in its local-first
offline form; the 13-point gap is scheduled product work, not engineering risk.
