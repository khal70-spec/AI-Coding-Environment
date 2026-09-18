# Phase 4 — Agents (Plan §4–§6, §33; CLAUDE build-order 14–19)

**Goal**: specialized agents consume the Phase-3 tool registry through one governed
loop. Every model→tool round trip is policy-checked, approval-gated (Plan §33),
budget-accounted (Phase 2), and audited. Agents never modify their own manifests.

**Entry state**: `phase-3-complete` (`8f34c21`): tool registry (fs/terminal/git/test/
scan/browser), evidence-checked verify, blocking lint, 418 tests green.

## P4.1 Agent loop kernel — DONE

- [x] Reconcile manifest tool vocabulary (`KNOWN_TOOLS`, per-agent `toolsAllow`)
  from Phase-0 aspirational names to the real Phase-3 registry ids
- [x] `AgentRunner` (packages/agents/src/runtime.ts): system-prompt synthesizes the
  agent's *allowed* tool surface; model responses parsed for tool-call blocks;
  each call runs `ToolRunner.call` with the agent's grant + task jail; results feed
  back trust-tagged; loop terminates on assistant message with no calls (final answer)
  or `maxIterations`
- [x] `APPROVAL_REQUIRED` short-circuits the loop into `awaiting-approval` (no side
  effects — proven by side-effect counters); orchestrator re-invokes with
  `approved: true` + approval evidence (rides Plan §33)
- [x] Denied calls (allowlist/scope/neverAllow) append a denial notice to the
  transcript and continue — agents can adapt, but the wall never moves
- [x] Transport-agnostic: the runner takes a `complete(messages)` function; the CLI
  wires `ProviderDispatcher` (egress/secret/budget gates stay enforced there)

## P4.2 Investigator — DONE

- [x] `investigate(taskContext)` — read-only manifest; walks the task jail with
  fs.read/fs.list/fs.search/git.exec, returns an investigation note (NO fs.write —
  artifacts returned to the orchestrator, manifest stays write-free)
- [x] Tests with mock transport: answer-only round, multi-round tool exploration,
  denial-adaptation, awaiting-approval, transcript assertion, jail-escape attempt
  from a hostile "model" lands as POLICY_DENIED/JAIL_ESCAPE events only

## P4.3 Architect/planner — DONE

- [x] `plan(task, investigation)` — produces a structured plan artifact
  (steps + touched paths); may `fs.write` inside the task workspace (manifest grant)
  with overwrite approval semantics intact
- [x] Plan shape: numbered steps, each `{ goal, files?, verify? }`; stabilizer tests

## P4.4 Implementer + tester loop — DONE

- [x] `implement(plan, approval)` — plan-scoped edits via fs.write/fs.edit (approval
  flow), `test.exec` runs inside the jail; failure feed-back into fix iterations;
  bounded by `MAX_FIX_ATTEMPTS` (engine); persists fresh `test_results` rows so the
  verify cross-check (P3.4) stays real
- [x] E2E with real dispatcher over a fixture repo (loopback OpenAI-compatible mock):
  multi-turn loop, tool output on the wire, redact layer + T11 backstop, egress gate
  (loopback-only-local vs remote rules), budget hook fired
  NOTE: evidence-rows flow proven at unit level (P4.4/P4.5); task-state guard
  E2E is deliberately deferred to Phase 6 (orchestrator engine wiring)

## P4.5 CLI + close-out — in flight (CLI DONE)

- [x] `agent list` (manifest inventory), `agent run <task> --phase …` with
  `--prompt` override + `--provider/--model` over `AICE_AGENT_*` env, approval
  resume via `--approved` (Plan §33 evidence recorded through existing `approve`),
  persistence in `agent_runs` (migration 004) + artifacts under jail `.aice/agent-runs/`
- [x] Docs sweep + policy-matrix rows + gate review (phase-4-gate-review.md)
- [ ] tag `phase-4-complete` — NOW

**Done = investigator/architect/implementer run end-to-end through the real
dispatcher against a fixture repo with a mock provider; every tool call audited;
approval gates proven side-effect-free; verify evidence stays machine-checked;
gates green + lint clean; `phase-4-complete` tagged.**
