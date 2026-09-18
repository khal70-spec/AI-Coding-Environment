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

## Phase 7 — Desktop UI (Plan §54.24–25, §4/31) — DONE (bridge-kernel POC lane)

- [x] P7.1 Bridge kernel in `packages/ui` (allowlist + pinned args + stable lanes +
  version/pinning fingerprint) — originally scoped as "Tauri IPC"; delivered as the
  shell-agnostic bridge protocol (ADR-001 divergence recorded, kernel reusable by the
  Tauri shell 1:1)
- [x] P7.2 HTTP adapter `apps/desktop/src/server.ts` (host gate, POST-only, 64KB cap
  with delivered 413, traversal-proof static, CSP/nosniff/frame-deny, no-store, no CORS)
- [x] P7.3 Vanilla ES-module SPA `apps/desktop/web` (§4.2 IA subset: projects / tasks /
  agent sessions / MCP / skills / audit; `textContent`-only rendering)
- [x] P7.4 Bridge fuzz + allowlist tests (`tests/unit/ui`) + server canopy tests
  (`tests/unit/desktop/server.test.mjs`) — incl. `__proto__` smuggle + 413-desync fixes found
- [x] P7.5 E2E operator workflow over the live server (`tests/unit/desktop/e2e.test.mjs`):
  governance brakes proven (approval + checkpoint), evidence self-attestation impossible,
  failure lanes stick, audit monotonic, cross-project isolation
- Gate: 517/517 tests, lint 0, tsc 0 → `docs/development/phase-7-gate-review.md`
- Deferred: Tauri/React shell, diff viewer, marketplace UI, tray/notifications, DOM-level
  SPA test runner (gate review "Explicit deferrals")

## Phase 8 — Security hardening (Plan §50) — DONE

- [x] P8.1 Blocking gate `npm run security:gate` (secrets → dep-audit → supply-chain →
  SAST-lite S1–S7), fail-loud proofs per lane (`tests/security/security-gate.test.mjs`:
  each lane must exit non-zero with named evidence on a live planted violation and
  restore green on cleanup)
- [x] P8.2 Seeded-deterministic fuzz (`FUZZ_SEED` replay): bridge envelopes (300 rand +
  120 structured + 100 traversal), command classifier + injection detector (determinism/
  totality/recall/honesty properties), path containment (IO-narrows-lexical invariant,
  homoglyphs), secret redaction (specimen recall + clean-text preservation)
- [x] P8.3 Sandbox-escape suite (physical contagion proofs: symlink/dir-symlink/
  traversal/backslash/device-path denials with side-effect ABSENCE off-jail; terminal
  argv-shape hard deny; env-by-construction scrubbing; every FS tool run-denies)
- [x] P8.4 Injection red-team corpus across 7 channels (file-read/tool-output/
  transcript/pr-title/diff-comment/commit-msg/mcp-output) + staged combination attack;
  undetected-by-design rows labeled with compensating controls (never silent)
- [x] P8.5 MCP abuse suite: 512KB cap boundaries (N/N+1), content-length lies,
  mid-write death, stall-bounded timeouts, giant params, argv metachar inertness,
  abuse-then-reuse state-poisoning checks
- [x] P8.6 Supply-chain mechanization R1-R4 (zero runtime deps, exact pins, no install
  hooks, lockfile v3) + dependency-policy.md v2
- [x] P8.7 Threat-model v2 with findings table F1-F7 + residual-risk log
- Hardened upstream: world-writable chmod rule (gte high), inline-code interpreter rule,
  piped-RCE generalized (curl/wget/fetch), override-safety adjective tolerance,
  aws-secret quoted-key form (package + gate lanes aligned)
- Gate: 565/565 tests, lint 0, tsc 0, security-gate GREEN →
  `docs/development/phase-8-gate-review.md`

## Phase 9 — Production readiness (Plan §50/51)

Signed builds + auto-update, crash recovery, backup/migrate, perf + a11y, full docs
(§49), release checklist, Definition-of-Done sign-off, first-release target workflow (§53).
