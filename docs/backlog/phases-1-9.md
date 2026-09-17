# Phases 1–9 Overview (Plan §50)

Each phase ends with a gate: tests + scans green, threat-model re-check, docs updated.

## Phase 1 — Core runtime (Plan §54.5–7)

Project/workspace manager, task engine + state machine wiring, Git integration (real),
SQLite driver + migrations + audit store, CLI project/task commands. Tests: integration
(fs/Git/SQLite), security (traversal, rollback, scoping).

## Phase 2 — Provider framework (Plan §54.9–11)

Provider abstraction impl, OpenAI/Anthropic/NVIDIA/generic/local adapters, model registry
+ discovery + capability tests, OS vault adapters + encrypted fallback, connection testing,
health + failover (classification-aware), budgets. Tests: adapter contract, redaction on
I/O, failover matrix.

## Phase 3 — Tool system (Plan §54.8, §18, §22–24)

fs/search/terminal/Git/test-runner/scanner/browser tools behind policy engine; command
classifier + sandbox levels 1–2; stack detection + test pipelines (.NET/Laravel/React/Python);
security pipeline hooks (Semgrep/Gitleaks/OSV/Trivy). Tests: policy matrix, injection,
SSRF, sandbox escape attempts.

## Phase 4 — Agents (Plan §54.12–19)

Agent abstraction + manifests, orchestrator, investigator (read-only), architect,
implementer, tester, security reviewer, code reviewer, docs/release agents. Tests: E2E
`task → plan → approval → implement → test → review` on fixture repos.

## Phase 5 — Context & routing (Plan §54.20–21)

Repo indexing (map/symbols/deps), context selection + budget trim, secret filtering,
task classifier, deterministic router, escalation, multi-model debate/vote. Tests:
retrieval quality, filter recall, routing determinism.

## Phase 6 — MCP & skills (Plan §54.22–23, §17/40/41)

MCP registry + OAuth + permissions + audit; skill registry + integrity + permission review;
plugin framework + install consent. Tests: malicious-server containment, elevation blocks.

## Phase 7 — Desktop UI (Plan §54.24–25, §4/31)

Tauri shell + React app: all §4.2 navigation, §4.3 palette, run timelines, approvals,
diffs, audit views; hardened IPC (§28). Tests: IPC allowlist + fuzz, E2E workflows.

## Phase 8 — Security hardening (Plan §50)

Threat-model audit, SAST/dep/secret gates blocking, fuzzing (IPC/parser/classifier),
sandbox-escape tests, injection red-team, MCP/plugin abuse suites, supply-chain review.

## Phase 9 — Production readiness (Plan §50/51)

Signed builds + auto-update, crash recovery, backup/migrate, perf + a11y, full docs
(§49), release checklist, Definition-of-Done sign-off, first-release target workflow (§53).
