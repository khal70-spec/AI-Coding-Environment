# Codebase Audit — 2026-09-17 (Phase 0)

Full-repo audit: every source file, test, script, config, and doc cross-checked against
the master plan (`AI_Coding_Environment_End_to_End_Plan.md`), the ADRs, and actual
runtime behavior. Evidence: `npm test` 146/146 green, `npm run test:workspaces` green
(13 packages, real tests), `npm run check:secrets` green (122 files), `npm audit` clean
(0 vulnerabilities), `aice doctor` green, `db:migrate` applies + idempotent re-run.

## 1. What is DONE (with evidence)

### Phase 0 gates (Plan §50, §57)

| Area | Status | Evidence |
|---|---|---|
| Frozen master spec + instruction layer (`README`, `CLAUDE.md`, `AGENTS.md`, `SECURITY.md`, `CONTRIBUTING.md`) | ✅ | files present |
| Repo layout §48 (`apps/`, `packages/`, `skills/`, `docs/`, `tests/`, `scripts/`, `.github/`) | ✅ (CI dir added in this audit) | tree |
| Threat model — 20 threats with mitigation/test/owner/residual | ✅ | `docs/security/threat-model.md` |
| Security policies (system/secret/coding/dependency) | ✅ | `docs/security/` |
| ADRs 001–008 + template | ✅ | `docs/adr/` |
| `packages/core` — state machine (19 states, explicit edges), risk + classification kernels, `Result`/`KernelError` | ✅ | `tests/unit/core` (state walk, failure exits, terminals) |
| `packages/policy` — deny-by-default evaluation kernel (tools, scope, network, classification, risk gates) | ✅ | `tests/unit/policy` + `tests/security/permission-bypass` |
| `packages/security` — secret patterns+redaction, command classifier, path containment (lexical + symlink), SSRF egress guard, injection detector | ✅ | `tests/unit/security/*`, `tests/security/*` |
| `packages/secrets` — vault interface, branded `SecretRef`/`SecretValue`, `MemoryVault` test double, last4-only `describe()` | ✅ | `tests/unit/secrets` |
| `packages/storage` — baseline schema (15 tables), forward-only migrations, no-secret-values rule, vault-ref column | ✅ | `tests/unit/storage` (drift guard), `tests/integration/storage` (real SQLite) |
| `packages/git` — argv builders (no shell strings), protected branches, destructive-arg detector, push gate | ✅ | `tests/unit/git`, `tests/security/command-injection` |
| `packages/providers` — `Provider` interface, protocols, capability model, validating registry (unverified ≠ routable) | ✅ | `tests/unit/providers` |
| `packages/orchestrator` — transition guards: plan approval, checkpoint, fix-loop budget, verify+independent-review before merge | ✅ | `tests/unit/orchestrator` |
| `packages/agents` — 9 built-in manifests (least-privilege), manifest validator (no wildcards/full terminal/project write/network-allow) | ✅ | `tests/unit/agents` |
| `packages/tools`, `packages/context`, `packages/mcp` — Phase 0 contracts: tool envelope validation, classified-chunk budget fit, MCP config validation (https-only, no wildcards, vault refs, audited-high-trust) | ✅ | `tests/unit/{tools,context,mcp}`, `tests/security/mcp-security` |
| CLI `aice` — version/help/doctor (offline) | ✅ | `tests/unit/cli` |
| Offline secret scanner + Gitleaks config | ✅ | `npm run check:secrets` |
| CI security-gates workflow | ⚠️ authored, parked at `scripts/ci/ci.yml` — installation to `.github/workflows/` blocked on token `workflows` permission (see `scripts/ci/README.md`); every gate verified locally | this audit |
| SQLite migration runner — zero-dep (`node:sqlite`), idempotent | ✅ (rewritten in this audit) | `tests/integration/storage/migrations.test.mjs` |
| Test suite | ✅ 146 tests | unit 20 files, security 7, integration 1 |

### Honest status of numbers

Prior backlog claimed 141 tests; the suite is now **146** (added: 2 storage drift-guard
unit tests, 3 migration integration tests).

## 2. What is NOT done (truthful remaining work)

### Phase 0 (this phase — open items)

- [ ] P0.6 phase-gate review: threat-model re-read, DoD spot check, tag
  `phase-0-complete` (this audit is the evidence base for that review).
- [ ] Install the authored CI workflow `scripts/ci/ci.yml` → `.github/workflows/ci.yml`
  (blocked on the automation token's `workflows` permission; see `scripts/ci/README.md`).
- [ ] `lint`/`typecheck` are honest no-ops until Phase 1 (eslint config + typescript
  dev-dep land with the first compiled packages — flagged by the scripts themselves).

### Phase 1 — Core runtime (per `docs/backlog/phases-1-9.md`)

- Project/workspace manager; task engine wired to persistence; **real** Git execution
  (spawn behind policy); SQLite driver decision + typed DAOs; audit store writes;
  CLI project/task commands; fs/Git/SQLite integration coverage beyond migrations.

### Phase 2 — Provider framework

- OS keychain adapters + encrypted vault fallback (only `MemoryVault` test double exists);
  provider network adapters (OpenAI/Anthropic/NVIDIA/generic/local); discovery +
  capability tests; health/failover with classification-aware routing; budgets.

### Phase 3 — Tool system

- fs/search/terminal/git/test-runner/scanner/browser executors (only envelopes +
  classifiers exist); sandbox levels 1–2; stack detection + test pipelines
  (.NET/Laravel/React/Python); Semgrep/Gitleaks/OSV/Trivy pipeline hooks.

### Phase 4 — Agents

- Runtime agent abstraction, planner/investigator/implementer/tester/reviewer loops,
  E2E `task → plan → approval → implement → test → review` on fixture repos.
- Advisory-only today: `GuardContext.reviewerModel`/`implementerModel` are recorded but
  independence is enforced at **agent** level (per Plan §3.6); model-level diversity is
  a routing policy decision for Phase 5.

### Phase 5 — Context & routing

- Repo index/symbols/deps, selection + secret-filtered assembly (only the budget-fit
  kernel exists), task classifier, deterministic router, debate/vote.

### Phase 6 — MCP & skills

- MCP registry/OAuth/transport/tool proxying (config validation only today); skill
  packages under `skills/` (placeholder README); plugin framework + install consent.

### Phase 7 — Desktop UI

- `apps/desktop/` skeleton only (by design); Tauri shell, React app, IPC allowlist,
  `packages/ui` primitives (empty placeholder).

### Phase 8 — Hardening

- Blocking OSV/Semgrep/SBOM gates in CI, IPC/parser/classifier fuzzing, sandbox-escape
  suites, injection red-team, supply-chain: workflow actions pinned to SHAs.

### Phase 9 — Production readiness

- Signed builds + updates, crash recovery, backup/migrate UX, perf/a11y, full user
  guide (`docs/user-guide/` is a placeholder), release checklist, DoD sign-off.

## 3. Gaps FOUND and FIXED in this audit

| # | Gap | Severity | Fix |
|---|---|---|---|
| 1 | All 14 workspace `test` scripts pointed outside the repo (`../../../tests/…` from `packages/<x>`) — ran **0 tests, exit 0** (silent hole; `test:workspaces` proved nothing) | **high** | Paths corrected to `../../tests/…`; 13 packages now run real tests (verified non-zero pass counts) |
| 2 | `.github/workflows/ci.yml` claimed by README layout, SECURITY.md, architecture docs, and backlog P0.1 (`[x]`) — **file did not exist** | **high** | Workflow authored: tests (root + workspaces), secret scan, `npm audit`, lint/typecheck soft gates, CLI doctor, migration idempotency; least-privilege permissions; Node 22+24 matrix. GitHub rejected pushing it to `.github/workflows/` (App token lacks the `workflows` permission), so it is parked at `scripts/ci/ci.yml` with a one-step install (`scripts/ci/README.md`); all docs state the parked status — no false claims remain |
| 3 | `db-migrate.mjs` crashed with a raw stack trace when the `sqlite3` CLI was absent (not a declared prerequisite); not idempotent (`INSERT` on the version PK fails on re-run); stale "Phase 1 will add 001_initial.sql" message | **high** | Rewritten on `node:sqlite` (engines-matched, zero-dep): applied-version skip, per-migration transaction, PRAGMA-outside-transaction handling, `INSERT OR IGNORE` in `001_initial.sql` (also idempotent via the sqlite3 CLI), actionable errors |
| 4 | `packages/storage/schema.sql` duplicated `migrations/001_initial.sql` (166 lines) with **no drift protection** | medium | Declared migrations the source of truth + `schema.sql` the reviewed mirror; drift-guard unit test asserts byte-exact mirror invariant; documented in `packages/storage/README.md` |
| 5 | `engines: ">=20"` (+ two docs) contradicted reality: tests/CLI execute `.ts` via type-stripping → Node ≥ 22.18 required (getting-started even said "≥ 22" in its own body) | medium | `engines` → `>=22.18.0`; README, getting-started, tech-stack aligned; CLI doctor enforces the true floor |
| 6 | `scripts/check-secrets.mjs` allowlisted nonexistent `tests/security/secret-patterns.test.mjs`; `.gitleaks.toml` comment claimed "two files escape both scanners" while its own allowlist covered **all of `tests/**`** | medium | Stale entry removed; Gitleaks allowlist narrowed to the actual fixture file; both scanners now mutually aligned + comment corrected |
| 7 | `.gitignore` ignored `Cargo.lock` — contradicts signed/reproducible builds (Plan §42/§47) which require committed lockfiles | low | Ignore rule removed (+note); `target/` still ignored |
| 8 | `tsconfig.base.json` Phase-1 landmines: `declaration`/`declarationMap` conflict with a `noEmit` typecheck; `.ts`-suffix imports need `allowImportingTsExtensions` | low | Base config is now `noEmit` + `allowImportingTsExtensions`; emit flags move to per-package configs in Phase 1 |
| 9 | Root `typecheck` script always exited 0 via `|| true` even with `tsc` missing — a gate that could never fail | low | Scripts now print an explicit "lands in Phase 1 — skipped" notice instead of silently succeeding |
| 10 | ADR-003 example YAML used non-canonical tool names (`search`, `git.diff`, `shell.raw`); ADR-007 guard text misplaced the checkpoint guard vs. the implemented guards | low | Clarification notes appended to both ADRs (decisions unchanged — pointers to `KNOWN_TOOLS` and to actual guard placement) |
| 11 | SECURITY.md listed SAST/lint/typecheck as *current* blocking gates; dependency-policy called OSV/Semgrep Phase-0 advisory — neither matched the missing/soft tooling | low | Both docs now state the phased truth (npm audit + secret scan + tests blocking now; OSV/Semgrep advisory from Phase 3, blocking Phase 8) |
| 12 | Doc rot: stale test count (141) and "Phase 1+" labels on now-working pieces (`db:migrate`, `tests/integration/`) | low | Backlog, user-guide, getting-started, tests/README updated to the current state |

## 4. Residual risks / follow-ups (not blockers)

- **Zero-match test globs exit 0**: `node --test` on a pattern with no matches prints
  pass 0 and succeeds. The audit fixed the wrong paths; future packages must ensure
  their glob actually matches (CI keeps root `npm test` as the authoritative count).
- **`node:sqlite` emits an ExperimentalWarning on Node 22.** Harmless here (dev-tool
  script); the Phase 1 driver decision (ADR-008) will settle the production driver.
- **GitHub Actions unpinned (`@v4`)**: Phase 8 supply-chain hardening pins SHAs
  (recorded in the workflow header + dependency-policy).
- **CI installation pending**: the workflow (`scripts/ci/ci.yml`) could not be pushed to
  `.github/workflows/` from this environment — GitHub requires the App's `workflows`
  permission, which the session token lacks. A maintainer reconnects with that
  permission and runs the one-step install in `scripts/ci/README.md`; the backlog
  checkbox flips then. Until it lands, the documented local gate sequence is the
  authoritative check.
- **Plan §33 auto-approval config** for medium risk is intentionally absent in Phase 0
  (guard treats medium like high until configured) — Phase 1 workspace policy.
