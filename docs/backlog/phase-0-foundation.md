# Phase 0 — Security & Architecture Foundation (Plan §50)

**Gate**: threat model + policies + ADRs + backlog + CI gates + compiling skeletons with
kernel tests. **No full UI.**

## P0.1 Repository & instruction hierarchy (Plan §57.1–3)

- [x] §48 repo layout (`apps/`, `packages/`, `skills/`, `docs/`, `tests/`, `scripts/`, `.github/`)
- [x] Frozen master spec (`AI_Coding_Environment_End_to_End_Plan.md`)
- [x] `README.md`, `CLAUDE.md`, `AGENTS.md`, `SECURITY.md`, `CONTRIBUTING.md`
- [x] Root `package.json` (workspaces), `tsconfig.base.json`, `.editorconfig`, `.gitignore`
- [x] `scripts/check-secrets.mjs` + `scripts/db-migrate.mjs`
- [x] CI with security gates (`.github/workflows/ci.yml`)

## P0.2 Threat model & policies (Plan §44/45, §57.4–5)

- [x] `docs/security/threat-model.md` — 20 threats with mitigation/test/owner/residual risk
- [x] `docs/security/security-policy.md` (system layer)
- [x] `docs/security/secret-policy.md`
- [x] `docs/security/coding-standards.md`
- [x] `docs/security/dependency-policy.md`
- [x] `docs/architecture/` — overview, tech-stack, data-flow

## P0.3 ADRs (Plan §57.5–11)

- [x] ADR-001 desktop shell (Tauri first)
- [x] ADR-002 provider interface
- [x] ADR-003 agent permissions
- [x] ADR-004 workspace isolation
- [x] ADR-005 MCP security
- [x] ADR-006 secret storage
- [x] ADR-007 task state machine
- [x] ADR-008 SQLite storage

## P0.4 Core package skeletons + kernel logic (Plan §54.4–13, §46)

Pure-logic kernels with unit + security tests (zero runtime deps):

- [x] `packages/core` — task states, transitions, risk levels, classifications, result types
- [x] `packages/policy` — allow/approval/deny evaluation kernel + dangerous-op blocklist
- [x] `packages/security` — secret patterns + redaction, command classifier, path containment, SSRF guards, injection detectors
- [x] `packages/secrets` — vault interface + in-memory test double + `describe()` (last4 only)
- [x] `packages/storage` — baseline `schema.sql` + migration list
- [x] `packages/git` — checkpoint/worktree command builders (no execution yet) + safety rules
- [x] `packages/providers` — `Provider` interface, protocol types, registry record schema, capability enum
- [x] `packages/orchestrator` — transition guard kernel (wraps `core` machine)
- [x] `packages/agents` — manifest schema + built-in manifests (investigator/implementer/…)
- [x] `packages/tools`, `packages/context`, `packages/mcp` — interfaces + README concept docs
- [x] `apps/cli` — skeleton (version/help/doctor; project/task commands in Phase 1)

## P0.5 Tests (Plan §46)

- [x] `tests/unit/` — state machine, policy matrix, redaction, classifiers, manifests
- [x] `tests/security/` — traversal, injection, leakage, SSRF, bypass, dangerous commands
- [x] `npm test` green (141/141); `npm run check:secrets` green; `npm audit` clean

## P0.6 Phase-gate review

- [ ] Threat-model re-read; residual risks accepted explicitly
- [ ] Definition-of-Done spot check (Plan §51 — Phase 0 subset)
- [ ] Tag `phase-0-complete`, open Phase 1 backlog
