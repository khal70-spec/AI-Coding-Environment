# Changelog

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
