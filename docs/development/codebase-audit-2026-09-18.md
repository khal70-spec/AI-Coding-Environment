# Codebase audit — 2026-09-19 (post-Phase-9, release-candidate state)

**Scope**: whole tree at `phase-9-complete` (`8e779d1c5edb99720f73b5e785373276ad1dab9e`).
**Method**: metrics from `git ls-files`, fresh gate runs, structural walk, doc-vs-code
drift check. Prior audit: `codebase-audit-2026-09-17.md` (Phase 0 baseline).

## 1. Metrics snapshot

| Metric | Value |
|---|---|
| Tracked files | 263 |
| Kernel source (TS, zero runtime deps) | 11,176 LOC across `packages/*/src` + `apps/*/src` |
| Suites / test LOC | 82 test files / 9,426 LOC → **580 tests, 0 fail** |
| Docs | 45 markdown files (~2,600 LOC) + README/SECURITY |
| Operator/CI scripts | 12 (`scripts/*.mjs`) |
| Packages | 13 (`packages/*`) + 2 apps (`cli`, `desktop`) |
| Migrations | 5 (additive-only, linted M1–M4) |
| ADRs | 12 |
| Phase tags | 11 (`phase-0-complete` … `phase-9-complete`) |
| Runtime dependencies | **0** (supply-chain R1 enforced) |
| Security test suites | 19 `tests/security/*` + embedded lanes in unit/integration |

Test file spread: unit ×56 (agents 8, cli 1, context 4, core 1, desktop 2, git 2, mcp 5,
orchestrator 2, policy 2, providers 6, secrets 2, security 5, storage 5, tools 10, ui 1),
security ×19, integration ×6 (cli-lifecycle, cli-providers, crash-recovery,
backup-restore, perf-budgets, release-workflow).

## 2. Gate evidence (verbatim, fresh runs on this audit date)

- `npm test` → `# tests 580 / # pass 580 / # fail 0`
- `npm run lint` → exit 0; `tsc --noEmit -p tsconfig.base.json` → exit 0
- `node scripts/security-gate.mjs` → lanes: secrets ✓ dep-audit ✓ (0 vulns)
  supply-chain ✓ (15 manifests, R1–R4) sast-lite ✓ (160 files, S1–S7, 1 visible allow)
  ⇒ `SECURITY GATE: GREEN`
- `node scripts/release-check.mjs` → R1–R10 ⇒ `RELEASE-CHECK: GREEN (10/10 rows)`
- `node scripts/release-verify.mjs` ⇒ `sums match` + `reproducible: byte-identical
  rebuild from HEAD` → `OK`

## 3. Package-by-package state

| Package | State | Key lanes | Notable suite(s) |
|---|---|---|---|
| `core` | DONE | ADR-007 state machine, types | `tests/unit/core` |
| `git` | DONE | argv-only runner, worktrees, redaction | `tests/unit/git` |
| `storage` | DONE | SQLite (WAL), migrations 1–5, DAOs (incl. dao-mcp), scoping | `tests/unit/storage`, integration storage lanes |
| `policy` | DONE | grants, verdicts, classification policy | `tests/unit/policy` |
| `security` | DONE | redact, paths, classifier, injection detector, ssrf, command safety | `tests/unit/security` + fuzz suites |
| `secrets` | DONE | vault/keychain lanes | `tests/unit/secrets` |
| `providers` | DONE (POC) | registry/router/dispatcher, script-replay + local-openai adapters, budgets, telemetry, health | `tests/unit/providers`, `integration/cli-providers` |
| `tools` | DONE | fs.read/write/edit/list/search, git-ops, terminal argv-only, scanners, test-runner, browser-fetch | `tests/unit/tools` (10 suites), sandbox-escape |
| `orchestrator` | DONE | TaskEngine + guards, workspace service, retry budget | `tests/unit/orchestrator` |
| `agents` | DONE (POC) | composer, plan structure, phases, review lanes | `tests/unit/agents` + cli-agent suites |
| `context` | DONE | repo-index, packers, routing | `tests/unit/context`, cli-context |
| `mcp` | DONE | registry/gates/README-grade client (http/stdio), skills digest/tamper lanes | `tests/unit/mcp`, mcp-abuse |
| `ui` | DONE (kernel) | bridge registry + commands (allowlist, args, lanes, fingerprint) | `tests/unit/ui` |
| `apps/cli` | DONE | full `aice` surface incl. context/agent/mcp/skill/provider/budget lanes | cli integration suites |
| `apps/desktop` | POC DONE | bridge HTTP server + vanilla ES-module SPA | `tests/unit/desktop`, a11y gate |

“DONE” = phase gate review passed with evidence; “(POC)” = lane works end-to-end
offline/locally with the conformance matrix still ahead (see §6).

## 4. Consistency / drift findings

Fixed during this audit (commit chain on this branch):

| # | Finding | Disposition |
|---|---|---|
| C1 | `docs/README.md` index rows stale (“Phase 0 in progress”, missing runbooks/release folders) | Updated |
| C2 | User guide lacked Phase 8/9 operator sections (security gate, backups, releases) | Added |
| C3 | Architecture overview ended at “What Phase 0 delivers” | Appended current-state (Phases 0–9) section — frozen baseline preserved |
| C4 | Inter-turn environment re-clones (verified twice) wipe local branch pointer + node_modules | Recovery lane codified in audit §7 + runbook series; never force-pushed |

No code-level contradictions found: CLI help text matches user-guide lanes; package
exports match `tsconfig`/imports; ADR table matches implementation (verified during
phase gates; ADR-001 divergence recorded in Phase 7 gate review).

## 5. Risk register carried forward (verbatim from threat-model v2.0)

Residual: multilingual injection detection (regex lane boundary), leetspeak/spacing
obfuscation, unicode-steganography hygiene class, Tauri-native bridge transport
re-certification. Compensating controls: display-only lanes + policy gating + climates
of audit; each numbered with an owner lane in the threat model.

## 6. Audit verdict

Release-quality for the POC-scope (local-first, fully offline, governed): **SHIP state
per DoD review**. Gate machinery blocks exactly what it claims to block (fail-loud
proven by planted-violation tests). Upstream hardening from audits/fuzz is landed, not
documented-over (Phase 7 `__proto__` find, Phase 8 F1–F7, Phase 9 a11y pair, restore
crash-line, 413-delivery race).

## 7. Environment/ops notes for future audits

- Sandbox re-clone between turns happened twice (Ph.9 audit, this audit). Symptoms:
  `git log -1` shows the base/main merge commit while working tree still carries the
  branch work as uncommitted/untracked. Recovery (proven, no history mutation):
  `git fetch origin <branch>:refs/remotes/origin/<branch>` → `git reset --mixed
  origin/<branch>` → `npm ci --ignore-scripts`. Never force-push to reconcile.
- Node: `npm ci --ignore-scripts` is the deterministic bench refresh (bin shims absent
  after re-clone).
