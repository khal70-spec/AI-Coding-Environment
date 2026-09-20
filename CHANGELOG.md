# Changelog

## [1.0.3] — 2026-09-20 (audit-verification + drift housekeeping)

- Full main-vs-plan audit (frozen spec §1–§57) re-verified from a fresh install:
  616/616 tests, security gate GREEN (5/5), lint/tsc clean, a11y A1–A15 GREEN;
  content identity proven `main == v1.0.2 tag + PR #4`. Report:
  `docs/development/codebase-audit-2026-09-20.md`
- Drift fixes: `@ai-coding-env/security` manifest 0.3.0 → 1.0.2 caught up (the 1.0.0
  15-manifest bump missed it; lockfile already carried 1.0.2), `aice version` banner
  0.6.0-phase6 → 1.0.2, release-checklist refreshed (v1.0.x header, R6 lane A1–A15,
  R11 signature row documented, sign/verify sequence)
- Fixture-hygiene rule documented: the security-gate suite restores its mutated
  `packages/security/package.json` fixture **from HEAD** (`git checkout --`) — never
  run the suite with uncommitted edits to that file
- §53 golden-workflow attestation renewed via scripted equivalent (release-workflow +
  golden-review-workflow suites 5/5 fresh green) — recorded in
  `docs/release/release-checklist.md`
- Version bump 1.0.2 → **1.0.3** (15 manifests + lock + CLI banner)

## [1.0.2] — 2026-09-19 (coverage + CI parity patch)

- Bridge allowlist completeness suite: every documented command exercised live
  (projects.list/tasks.list/tasks.show/tasks.fail/audit.list/mcp.list/skills.list)
  plus a suite-level guard (≥9 distinct lanes dispatched per file) so future pruning
  trips immediately (18/18 bridge suite total)
- CI template brought to parity: lint marked blocking (since Phase 3), a11y gate
  (A1-A15) and deterministic artifact + reproducibility steps added; the signing
  caveat documented (publisher key never on CI runners — release-check stays an
  operator lane)
- New runbook: test-flake triage ladder (re-run → isolate → fixtures hygiene →
  statics candidates → corpus policy), with the v1.0.1 transient recorded

## [1.0.1] — 2026-09-19 (release-hardening patch)

- Security gate gains a 5th lane: `sbom-manifest` (deterministic CycloneDX validation
  + zero-runtime cross-check), header dynamic
- a11y rules A14 (labeled form controls) + A15 (aria-current on nav) — 4 real fix-ups
  (labeled selects/inputs, aria-current on nav)
- Golden v1.0 review-workflow e2e (diff → merge-preview → signing chain), incl. a
  git invariant probe: worktree-add refuses checked-out branches (test exercises the
  correct geometry)
- Runbook: publisher key rotation; threat-model controls inventory updated
- Root-cause follow-through on the R11 drift class: `--pin` lanes everywhere, fixtures
  strictly repo-pure


All notable milestones. Version follows the deterministic artifact train
(`release-prepare` names artifacts `aice-v<version>-<shortsha>`).

## [1.0.0] — 2026-09-19 (GA, local-first governed track)

The offline-executable product is complete end-to-end: governed runtime, agents,
providers, tools, MCP, context, bridge kernel + desktop POC, security machinery,
operations lanes, and reproducible signed releases.

### Phases (tagged)
- **phase-0** security & architecture foundation (threat model, ADRs, plan freeze)
- **phase-1** core runtime: state machine, approvals, audit, storage
- **phase-2** providers & secrets: registry/router/dispatcher, budgets, vault lanes
- **phase-3** tool system: fs/git/terminal/scanners/test-runner, sandbox proofs
- **phase-4** agents: composer pipeline, bounded retries, `agent_runs` evidence
- **phase-5** context engine: index/pack/route, context CLI lanes
- **phase-6** MCP + skills: gates, contained client, digest/tamper lanes
- **phase-7** UI bridge kernel + hardened desktop POC; `__proto__` fuzz find landed
- **phase-8** blocking security gate: secrets/dep-audit/supply-chain/SAST +
  fail-loud probes, seeded fuzz, red-team corpus; upstream hardening F1–F7
- **phase-9** production readiness: SIGKILL crash recovery, verified backup/restore,
  perf budgets, deterministic artifacts, readiness matrix, §53 golden workflow
- **phase-10** depth increment: unicode canonicalization detector lane, socket-level
  provider conformance harness, deterministic CycloneDX 1.5 SBOM, diff-viewer lane
- **phase-11** release hardening: ed25519 signed artifact chain (pinned publisher
  pubkey), merge-preview lane (`merge-tree`, worktree-safe), a11y A10–A13 incl.
  computed WCAG AA contrast, incident/provider runbooks

### 1.0.0 changes over phase-11 tag
- Version bump 0.3.0 → **1.0.0** (15 manifests + lock)
- Readiness matrix now **11 rows**: R11 = release signature verify (`--require-signature`)
- CHANGELOG added; docs/README index refreshed

### Metrics at 1.0.0
- 611 tests green (unit 62 suites + security 20 + integration 10 files)
- 0 runtime dependencies (policy enforced), 93k+ combined source+test LOC
- 12 operator/CI scripts, 5 additive migrations, 12 ADRs, 14 gate-review docs

### Known deferrals (owner lanes, not fog)
Native Tauri shell + derivatives (binary signing, auto-update, tray, OAuth-remote
MCP, marketplace UI, React port, human AT pass) — environment-blocked in this
sandbox with three recorded datapoints; bridge-kernel continuity proof covers the
trunk. Model-backed multilingual injection detector + live-vendor credentialled
conformance runs — resource-dependent in this environment.
