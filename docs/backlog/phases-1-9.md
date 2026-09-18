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

## Phase 5 — Context & routing (Plan §54.20–21) — IN FLIGHT

- [x] P5.1 repo index: lexical walk (symlinks never followed), regex symbol
  extraction (ts/py/c#/php), internal-import edges, secret-path exclusion,
  `.aice/context/index.json` persistence — `packages/context/src/repo-index.ts`
- [x] P5.2 retrieval + budget trim: deterministic scoring (path terms, symbol
  names, import adjacency, operator hints), precedence-pinned, `fitBudget` pack —
  `retrieval.ts`; retrieval-quality + determinism fixtures
- [x] P5.3 secret filtering: cap+redact filterChunkText lane, redacted-hash
  admission, canary recall measured against detector coverage
- [x] P5.4 classifier + deterministic router + escalation + debate/vote —
  `routing.ts` (rules: clearance→restricted-local-only→high-risk-strong→kind→cost,
  id-tiebreak; ties escalate, never silently resolved)
- [x] P5.5 CLI wiring: `aice context build` (index+pack persisted under
  `.aice/context/`, content-free audit) + `aice route` (decision against live
  registry; exit 1 on honest "(none)" lane); status vocabulary aligned with
  registry (available|degraded); CLI-spawn smoke tests incl. restricted pinning

## Phase 6 — MCP & skills (Plan §54.22–23, §17/40/41) — IN FLIGHT → DONE (POC lanes)

- [x] P6.1 MCP registry (dao-mcp: McpServersDao + PermissionsDao) + install
  validation hardened (wildcards forbidden in allow AND deny; credentials only
  via vault://; high-trust requires recorded review; http = loopback-only)
- [x] P6.2 contained client: JSON-RPC 2.0 over http(s)+stdio; endpoint re-checks
  at call time (defense in depth); byte caps, timeouts, redirect refusal, no
  shells (argv-only); `networkAllow` self-pinning (loopback host:port exact; https
  remote via SSRF blocklist); kill switch per server
- [x] P6.3 skills: whole-bundle sha256 (paths+bytes canonical order, symlinks
  refused), namespaced permission manifests; SkillsDao p-in-pending→approved|
  blocked; tamper ⇒ auto-BLOCKED (mismatch can never be approved through)
- [x] P6.4 CLI: `aice mcp add|list|remove|enable|disable|invoke` with gate
  decision before any socket (invokes audited content-free); `aice skill
  add|list|review|approve|gate` lane (review=consent surface)
- [x] tests: malicious-server containment matrix (oversize/redirect/dead/silent/
  inert-argv), elevation blocks (deny-ladder incl. perms tighten-only)
- OAuth for MCP servers: deferred (local/self-hosted trust model first — remote
  OAuth lands with remote-server support, post-Phase 6 POC)
- plugin framework: MCP servers ARE the plugin registry in this POC; a fuller
  marketplace surface lands after the UI (Phase 7+).

## Phase 7 — Desktop UI (Plan §54.24–25, §4/31)

Tauri shell + React app: all §4.2 navigation, §4.3 palette, run timelines, approvals,
diffs, audit views; hardened IPC (§28). Tests: IPC allowlist + fuzz, E2E workflows.

## Phase 8 — Security hardening (Plan §50)

Threat-model audit, SAST/dep/secret gates blocking, fuzzing (IPC/parser/classifier),
sandbox-escape tests, injection red-team, MCP/plugin abuse suites, supply-chain review.

## Phase 9 — Production readiness (Plan §50/51)

Signed builds + auto-update, crash recovery, backup/migrate, perf + a11y, full docs
(§49), release checklist, Definition-of-Done sign-off, first-release target workflow (§53).
