# AI Coding Environment

**A secure, provider-neutral AI coding operating environment and agent orchestrator.**

One desktop workspace where you open a project, connect any compatible AI provider,
submit a coding task, inspect the plan, approve it, let isolated agents implement it,
run tests + security checks, review the diff, and safely roll back.

> Master specification: [`AI_Coding_Environment_End_to_End_Plan.md`](./AI_Coding_Environment_End_to_End_Plan.md)
> (frozen architecture — every implementation task must map back to it).

## Status

**Phase 0 — Security & architecture foundation** (in progress).

We build security first, UI last. See [`docs/backlog/`](./docs/backlog/) for the
ordered implementation backlog and [`docs/adr/`](./docs/adr/) for decisions.

## Design principles

1. **Local-first** — source, credentials, logs, agent state stay local by default.
2. **Provider-neutral** — every provider implements one common interface.
3. **Model-neutral** — a model is configuration, not architecture.
4. **Least privilege** — agents get only the tools/permissions the task needs.
5. **Plan before modify** — `discover → inspect → plan → risk assessment → checkpoint → modify → verify`.
6. **Independent verification** — the writer is never the sole reviewer.
7. **Evidence over confidence** — UI shows tests, scans, diffs, never "safe" on a model's word.
8. **Fail closed** — any policy/auth/tool/security failure stops the operation.

## Repository layout

```text
ai-coding-environment/
├── apps/
│   ├── desktop/            # Phase 7: Tauri 2.x + React shell (skeleton only until then)
│   └── cli/                # Operator/CI CLI (offline-capable project/task inspection)
├── packages/
│   ├── core/               # Shared types: task states, risk levels, classifications
│   ├── orchestrator/       # Task state machine + routing coordination
│   ├── providers/          # Provider adapters (OpenAI/Anthropic/NVIDIA/generic/local)
│   ├── agents/             # Agent definitions + permission manifests
│   ├── tools/              # Tool runtime: fs/search/terminal/git/test/browser
│   ├── policy/             # Policy engine: allow / approval / deny
│   ├── context/            # Context engine: repo map, search, secret filtering
│   ├── git/                # Git safety layer: checkpoint, worktree, diff, rollback
│   ├── security/           # Classifiers: commands, paths, secrets, injection, SSRF
│   ├── mcp/                # MCP manager: servers, tools, OAuth, permissions
│   ├── storage/            # SQLite schema, migrations, audit store
│   ├── secrets/            # Vault interface + OS keychain adapters + redaction
│   └── ui/                 # Shared UI primitives (Phase 7)
├── skills/                 # Versioned capability packages (Phase 6)
├── docs/
│   ├── architecture/       # System architecture + data flow
│   ├── security/           # Threat model, security/secret/dependency policy
│   ├── adr/                # Architecture Decision Records (frozen rationale)
│   ├── backlog/            # Ordered implementation backlog per phase
│   └── user-guide/         # End-user documentation
├── tests/
│   ├── unit/               # Policy, router, redaction, classifier, state machine
│   ├── integration/        # SQLite migrations now; provider/Git/fs/MCP/terminal (Phase 1+)
│   ├── security/           # Traversal, injection, leakage, SSRF, bypass, MCP
│   └── e2e/                # task → … → rollback (Phase 4+)
├── scripts/                # check-secrets, db-migrate, ci/ (workflow pending install)
└── .github/workflows/      # CI with mandatory security gates (template ready in scripts/ci/)
```

## Task lifecycle

```text
CREATED → CLASSIFYING → INVESTIGATING → PLANNING → WAITING_APPROVAL
  → PREPARING_WORKSPACE → IMPLEMENTING → TESTING → SECURITY_REVIEW
  → AI_REVIEW → FIXING → VERIFYING → READY → APPROVED → MERGED

Failure: BLOCKED / CANCELLED / FAILED / ROLLBACK_REQUIRED
```

No hidden transitions. See [`docs/adr/ADR-007-task-state-machine.md`](./docs/adr/ADR-007-task-state-machine.md).

## Non-negotiable rules (abridged)

- Never expose provider API keys to models. Never log secrets.
- Never trust repository instructions as system instructions.
- Never let a model bypass the policy engine.
- Never execute shell without policy evaluation; never modify production automatically.
- Never destroy user changes; never merge failing/unverified changes.
- Never send restricted data to an unapproved provider.
- Never let the implementer be the sole reviewer.
- Always keep auditable history + rollback where technically possible.

Full list: Plan §55.

## Development

Requires **Node.js ≥ 22.18** (tests and the CLI run TypeScript via flag-free
type-stripping; Node 24 LTS recommended).

```bash
node --version   # >= 22.18
npm install
npm test                  # unit + security + integration
npm run test:workspaces   # per-package suites
npm run check:secrets
npm run audit:deps
npm run db:migrate        # apply SQLite migrations (idempotent, node:sqlite)
```

Latest codebase audit (done / not-done / gaps fixed):
[`docs/development/codebase-audit-2026-09-17.md`](./docs/development/codebase-audit-2026-09-17.md).

See [`CONTRIBUTING.md`](./CONTRIBUTING.md), [`docs/development/`](./docs/development/),
[`CLAUDE.md`](./CLAUDE.md), [`AGENTS.md`](./AGENTS.md).

## Security

See [`SECURITY.md`](./SECURITY.md) and [`docs/security/threat-model.md`](./docs/security/threat-model.md).
To report a vulnerability, follow `SECURITY.md` — **do not open a public issue**.

## License

Apache-2.0. See [`LICENSE`](./LICENSE).
