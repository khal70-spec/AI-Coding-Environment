# Phase 4 gate review — Agents

**Date:** 2026-09-17 · **Scope:** P4.1–P4.5 (agent manifests, `AgentRunner` kernel,
investigator/architect/implementer flows, `agent_runs` persistence, `aice agent`
CLI plumbing, dispatcher E2E) · **Baseline at review:** gate suite 449/449, tsc + lint clean.

## 1. Gate evidence

| Gate | Result |
| --- | --- |
| Unit + integration + security tests (root) | **449/449** |
| `tsc --noEmit -p tsconfig.base.json` | clean |
| `npm run lint` | 0 problems, exit 0 |
| Transports proven | offline script replay (CLI spawns) + **real dispatcher × loopback OpenAI mock (real fetch)** |
| Persistence proven | `agent_runs` (migration 004), audit events, `runs` evidence rows, `.aice/agent-runs/` artifacts |

## 2. What exists

- **Kernel** (`packages/agents/src/runtime.ts`): transport-agnostic model↔tool loop.
  System prompt shows only the agent's *registered allowlist* (manifest ∩ registry);
  fenced `​```tool` JSON protocol with structural pinning; per-call `evaluate()` before
  a single side effect; denials become transcript notices; `APPROVAL_REQUIRED` stops the
  loop side-effect-free with a `pendingApproval` payload; `--approved` resumes after
  Plan §33 evidence is on file; `maxIterations` hard clamp; `transport-error` lane.
- **Flows** (`investigator.ts`, `architect.ts`, `implementer.ts`): thin profiles over
  the kernel with section-guided outputs (INVESTIGATION NOTE / PLAN / IMPLEMENTATION
  SUMMARY). Implementer prefers `fs.edit` (literal replace) — fs.write over existing
  files stays approval-gated, and the fix-loop runs **real** `test.exec` children.
- **Persistence**: `agent_runs` (transcript verbatim, status/rounds/denials, model id),
  `TasksDao.runs` rows as task evidence, content-free audit events, artifact files under
  the jail's `.aice/agent-runs/` (`<id>.transcript.json`, `<id>.final.md`).
- **CLI**: `aice agent list`, `aice agent run <task> --phase …` (script-file or provider
  transport via `--provider/--model`/`AICE_AGENT_*`; keys remain vault-only), jail =
  task's active workspace else project root, task classification feeds the egress
  context. `aice task inspect <id>` bundles runs/agent sessions/tests/findings/audit.

## 3. Threat-model re-read (agent-facing threats)

| Threat | Claim | Phase 4 evidence | Residual |
| --- | --- | --- | --- |
| T9 jail break via model-requested paths | per-call policy + lexical/realpath jail | hostile-model suite: `../../../../etc/passwd` → `JAIL_ESCAPE` denial, zero bytes read, no transcript leak | ✅ accepted |
| Grant escape (`fsWrite=none`, reserved ids) | allowlist shown ∩ enforced | investig時代ator `fs.write`/`mcp.call` attempts → 2/2 denied (`POLICY_DENIED`), no side effects, denial surfaced to model | ✅ accepted |
| Overwrite/clobber without consent | fs.write on existing file requires approval | investigator/architect/implementer all stall `awaiting-approval` **before** writes (byte-identical target files asserted); approved resume then executes | ✅ accepted; resume is per-invocation, human-in-loop re-issue required |
| Runaway/looping model | max-iterations clamp | runaway loop pinned at N transports; zero extra calls past clamp | ✅ accepted |
| Untrusted I/O confusion | trust tags + structural protocol | tool outputs wrapped `UNTRUSTED-TOOL-OUTPUT` (wire-verified at dispatcher E2E); malformed blocks become protocol notices, never crashes | ✅ accepted |
| Secrets on the wire (T11) | layered: P3 redact + dispatcher gate | happy path: fs.read output redacted pre-transcript (wire dump has no token); backstop: token in any lane denied with **zero socket writes** | ✅ accepted |
| Provider egress to private/metadata hosts | exit-node rules | remote protocol × 169.254.169.254 denied pre-flight; only `local-openai-compatible` may touch loopback — and that is exactly the E2E lane | ✅ accepted |
| Audit gaps | content-free audit + verbatim transcripts | `agent.run.<phase>` audit rows carry counts/jail/status only; transcripts live in `agent_runs` and are **never executed from DB** | ✅ accepted |

## 4. Policy matrix — agent-driving rows (all proven in tests)

| Call | Grant → verdict |
| --- | --- |
| investigator: `fs.read/list/search`, `git.exec` read shas | allow (executes in jail) |
| investigator: `fs.write`, `fs.edit`, `terminal.exec`, `test.exec`, `scan.exec`, `mcp.call`, reserved ids | deny `POLICY_DENIED` |
| architect: `fs.write` new artifact | allow; existing file → `APPROVAL_REQUIRED` |
| implementer: `fs.edit` literal replace | executes when `--approved` set (Plan §33), else `APPROVAL_REQUIRED` |
| implementer: `fs.write` existing file / `git.exec commit` | `APPROVAL_REQUIRED` stall, side-effect-free |
| any agent: path outside jail | deny `JAIL_ESCAPE` (allow/deny paths both notice-tagged) |
| any agent: allowed id but unregistered in the runner | deny (`TOOL-UnregisteredCall` lane) — visible surface is truthful |

## 5. Deferred to Phase 6 (Phase 5 context first)

- State-machine guard transitions during agent runs (`task advance` stays manual — by design of the engine invariants; agent phases annotate `runs` but never self-advance).
- Tester/security-reviewer/docs/release agent profiles (kernel + flows ready; manifests already validate).
- UI surface for `agent_runs` (Phase 7).

## 6. Signature

Phase 4 objective met: governed agents execute tool-bearing work end-to-end through
real policy jails and real provider dispatch, with hostile-model denial proofs,
side-effect-free approval stalls, replayable persistence, and zero additions to the
trust surface beyond vault-referenced credentials.
