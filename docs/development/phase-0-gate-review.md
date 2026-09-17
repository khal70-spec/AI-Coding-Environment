# Phase 0 Phase-Gate Review — 2026-09-17

**Gate** (per `docs/backlog/phase-0-foundation.md` P0.6): threat-model re-read,
Definition-of-Done spot check, decision to open Phase 1.
**Evidence base**: `docs/development/codebase-audit-2026-09-17.md` (146/146 tests,
secret scan clean, audit clean, migration idempotency verified).

## 1. Threat-model re-read (all 20 threats, Phase-0 posture)

| Threat | Phase 0 posture | Test evidence today | Residual risk accepted? |
|---|---|---|---|
| T1 malicious repo instructions | Instruction hierarchy enforced (CLAUDE/AGENTS/system policy); detector kernel | `tests/security/prompt-injection` | ✅ accepted (defense-in-depth; detector is one layer) |
| T2 prompt injection | Detector + trust rules; full E2E red-team = Phase 8 | `tests/security/prompt-injection` | ✅ accepted (documented medium residual) |
| T3 malicious MCP server | Config validation only (https, no wildcards, vault refs, audited high-trust); manager = Phase 6 | `tests/security/mcp-security` | ✅ accepted (no MCP runtime before Phase 6) |
| T4 malicious skill/plugin | Placeholder only; framework = Phase 6 | — (Phase 6) | ✅ accepted (no runtime present) |
| T5 stolen API key | Handle-only vault interface + redaction; no real keys exist yet; OS adapters = Phase 2 | `tests/security/secret-redaction`, `scripts/check-secrets` | ✅ accepted |
| T6 compromised provider | Models untrusted by design; no provider I/O before Phase 2 | policy/engine matrix | ✅ accepted |
| T7 malicious dependency | Zero runtime deps; lockfile; audit gate | `npm audit` clean | ✅ accepted |
| T8 shell command injection | Classifier blocks destructive shapes; argv-only git runner (Phase 1) wraps it | `tests/security/command-injection` | ✅ accepted |
| T9 path traversal | Lexical + symlink containment kernels | `tests/security/path-traversal` | ✅ accepted |
| T10 SSRF | Default-deny egress guard; runtime fetchers = Phase 2+ | `tests/security/ssrf` | ✅ accepted |
| T11 secret exfil via context | Redaction + classification kernels; context engine = Phase 5 | `tests/security/secret-redaction` | ✅ accepted |
| T12 hallucination as fact | Evidence-over-confidence rules; process enforcement = Phase 4+ | guard: no unverified merge | ✅ accepted |
| T13 confused deputy | Manifests + arg validation contract | `tests/security/permission-bypass` | ✅ accepted |
| T14 privilege escalation | No-self-modify manifests + validator | `tests/security/permission-bypass` | ✅ accepted |
| T15 IPC abuse | No desktop yet (Phase 7); design frozen in ADR-001 | — (Phase 7) | ✅ accepted |
| T16 release supply chain | Prerelease warning; signed builds = Phase 9 | — (Phase 9) | ✅ accepted |
| T17 malicious browser content | No browser worker before Phase 3 | — (Phase 3) | ✅ accepted |
| T18 unsafe automation | No scheduler exists; machine guards apply to automation later | — (Phase 4) | ✅ accepted |
| T19 accidental destruction | Destructive-op classifiers + checkpoints/worktrees (runtime in Phase 1) | `tests/security/command-injection` | ✅ accepted |
| T20 cross-project leakage | Schema scoping (project_id everywhere); DAO-level scoping ships with Phase 1 storage | scoping tests (Phase 1 gate) | ✅ accepted |

No new threats surfaced by the audit fixes (CI workflow, migration runner, path fixes).
The migration runner inherits T19 containment: forward-only, idempotent, transactional.

## 2. Definition-of-Done spot check (Plan §51 — Phase-0 subset)

| DoD item | Phase-0 status |
|---|---|
| No critical/high vulns | ✅ `npm audit --audit-level=high` clean |
| Keys secure / never in DB or logs | ✅ handle-only vault interface; no key storage exists yet (Phase 2 OS adapters) |
| Redaction on tool/model/log paths | ✅ kernel + adversarial tests |
| Dangerous ops gated | ✅ command/git classifiers + policy kernel + orchestrator guards |
| Isolated workspaces | ✅ design frozen (ADR-004); argv builders tested; runtime = Phase 1 gate |
| Rollback | ✅ state machine has `ROLLBACK_REQUIRED`; runtime rollback = Phase 1 gate |
| Independent review | ✅ merge guard denies implementer-as-reviewer (tested) |
| Mandatory tests/scans before merge | ✅ `MERGED` guard requires green tests + green scans (tested) |
| No merge of unverified changes | ✅ structurally impossible (state machine + guards; negative tests) |
| Auditability | ✅ append-only audit schema; event writes = Phase 1 gate |
| Docs | ✅ architecture, threat model, policies, ADRs, backlog current (audit-fixed) |
| CI gates | ⚠️ workflow authored + locally proven; GitHub install blocked on App `workflows` permission (`scripts/ci/README.md`) — accepted open item, local gates equivalent |

## 3. Decision

Phase 0 is **complete**. Residual risks above are accepted as phase-scoped (each maps to
a later-phase deliverable in `docs/backlog/phases-1-9.md`). Open items carried into
Phase 1: CI workflow installation (external permission blocker), real lint/typecheck
(typescript dev-dep + config), storage DAO scoping tests, git runner runtime tests.

Tag `phase-0-complete` set; Phase 1 backlog opened: `docs/backlog/phase-1-core-runtime.md`.

**Signed off**: 2026-09-17, gate review by agent-mode audit workflow (evidence cited above).
