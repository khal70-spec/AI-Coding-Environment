# Architecture Overview (Plan §29)

## System shape

```text
Desktop UI (React + TypeScript, unprivileged renderer)
        |
        v  strict IPC allowlist (validated messages only)
Desktop shell (Tauri 2.x — see ADR-001)
        |
        v
Local application core (TypeScript service layer; Rust for privileged ops in later phases)
  +---- Provider adapters (ADR-002)     # OpenAI / Anthropic / NVIDIA NIM / generic / local
  +---- Agent orchestrator (ADR-007)    # task state machine + coordination
  +---- Policy engine                   # allow / approval / deny on every tool call
  +---- Tool runtime                    # fs / search / terminal / git / tests / browser
  +---- Context engine                  # repo map, search, per-agent context, secret filtering
  +---- Git / workspace manager (ADR-004)
  +---- Security engine                 # classifiers: commands, paths, secrets, SSRF, injection
  +---- MCP manager (ADR-005)
  +---- Model router + registry         # deterministic routing, failover, budgets
  +---- Audit store (ADR-008)           # SQLite; secrets in OS store / vault (ADR-006)
```

## Trust boundaries

1. **Renderer ⇄ backend**: untrusted UI; every IPC message validated; no renderer-provided
   shell/paths executed directly (Plan §28).
2. **Model ⇄ core**: models are untrusted decision-makers; outputs pass policy, tests,
   review, and approval before any effect (Plan §1, §18).
3. **Repo/tool/MCP content ⇄ agents**: untrusted data; prompt-injection defenses (Plan §16).
4. **Workspace ⇄ user tree**: task work happens in isolated worktrees; merge only after
   verify + approval (ADR-004).
5. **Network**: default DENY with per-task allowlist (Plan §20).

## Request lifecycle (happy path)

```text
Task(CREATED) → classify → investigate(read-only) → plan → WAITING_APPROVAL
→ user approves → checkpoint + isolated worktree → implement → test → security review
→ independent AI review → fix/verify loop → READY → APPROVED → merge → audit
```

Every transition is explicit, logged, and reversible where technically possible.

## Package map

| Layer | Package | Plan |
|---|---|---|
| Shared types | `packages/core` | §32/33/36 |
| Policy engine | `packages/policy` | §8/18 |
| Secrets | `packages/secrets` | §11 |
| Storage/SQLite | `packages/storage` | §26/30 |
| Git safety | `packages/git` | §21 |
| Providers | `packages/providers` | §10–13 |
| Orchestrator | `packages/orchestrator` | §7/32 |
| Agents | `packages/agents` | §7/8 |
| Tools | `packages/tools` | §18/22–24 |
| Security classifiers | `packages/security` | §9/16/20/23 |
| MCP | `packages/mcp` | §17 |
| Context | `packages/context` | §15 |

## What Phase 0 delivers

Frozen spec, ADRs, threat model, policies, backlog, CI gates, and compiling
skeletons for `core`, `policy`, `secrets`, `storage`, `git`, `providers`,
`orchestrator`, `agents`, `tools`, `security`, `mcp`, `context` with unit +
security tests for the pure-logic kernels. No full UI (Plan §50).


---

## Current state (Phases 0–9, release candidate)

The Phase-0 baseline above holds. What exists today beyond it:

- **providers**: registry + router + dispatcher with script-replay and
  local-openai-compatible adapters, budget lanes (`budget set/events`), telemetry and
  health tracking. Secrets PVC-lanes (`provider key set --stdin`).
- **tools**: fs/gits/terminal/scanner/test-runner/browser-fetch set behind
  `ToolContext` (jail, grant, policy ctx); argv-only execution, capped redacted output,
  inert `$(…)` shape proofs.
- **agents**: composer pipeline (investigate → plan → implement → review → fix,
  bounded retries) writing `agent_runs` rows + content-free audit for every round.
- **context**: repo index + packers + routing (task → context bundle), CLI lanes
  `context *`, model routing by risk/classification.
- **mcp**: server registry, gates (deny ladder), contained client (http/stdio), skills
  digest + tamper-block approvals. OAuth/remote profile: deferred (fail-closed today).
- **ui (bridge kernel) + desktop app**: `packages/ui` allowlisted bridge commands over
  DAOs/engine; `apps/desktop` hardened HTTP adapter + vanilla SPA. Tauri shell: deferred
  to the packaged product (ADR-001 divergence, recorded).
- **release planes**: deterministic artifacts (`release-prepare`/`release-verify`),
  readiness matrix (`release-check` R1–R10), operator runbooks, reproducible
  backup/restore + crash recovery lanes.

See each gate review for the phase-level evidence chains.
