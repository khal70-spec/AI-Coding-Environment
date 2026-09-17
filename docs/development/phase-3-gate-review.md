# Phase 3 gate review — Tool system

**Date:** 2026-09-17 · **Scope:** P3.1–P3.5 (`runtime.ts` funnel, fs/search/git/test/scan/browser
executors, verify evidence layer, blocking lint) · **Baseline at review:** gate suite green.

## 1. Gate evidence

| Gate | Result |
| --- | --- |
| Unit + integration + security tests (root) | **385/385** |
| Workspace test suites | **13/13 green** (tools 122, security 104, orchestrator 11, storage 20, providers 57, policy 19, secrets 15, git 13, core 8, agents 3, mcp 2, cli 2, context 1) |
| `tsc --noEmit` | clean |
| `npm run lint` (blocking since P3.5) | **0 problems, exit 0** |
| `npm run check:secrets` | clean (187 tracked files) |
| `npm audit --audit-level=high` | 0 vulnerabilities |

Test namespace growth this phase: +157 assertions/tools-adjacent suites
(envelope, runner, fs, terminal, sandbox, git tools, stack fixtures, test runner,
scanners, browser fetch, DAOs, engine evidence, policy matrix, CLI lifecycle).

## 2. Threat-model re-read (tool-facing threats)

| Threat | Phase 0 claim | Phase 3 evidence | Residual |
| --- | --- | --- | --- |
| T9 path traversal / jailbreak | containment jail on every fs path | lexical + symlink-ancestor realpath proof on read/write/list/search/edit; escape tests (../../, absolute, symlink-out-of-jail) all denied; regression test for `conf.txt` device-prefix bug | ✅ accepted |
| T10 command injection / destructive ops | classifier + argv-only, no shell | `terminal.exec` adversarial suite: `;`, `\|`, backticks, `$(...)` proven inert argv DATA; `sh -c`/`node -e`/`bash -lc`/`/bin/x` hard-deny; `rm -rf /`, `curl|sh`, force-push, `reset --hard`, `clean -fd` denied pre-spawn even after approval evidence | ✅ accepted; **level 1 cannot block child socket egress** — bwrap/firejail markers land with level 2 (`sandbox-detect.ts`) |
| T9' hostile workspace content becoming instructions | untrusted tagging | every tool output wrapped in `<<<UNTRUSTED-TOOL-OUTPUT>>>` after redact + byte-cap; runner tests assert tags on allow and deny paths | ✅ accepted |
| Secrets leaking into tool output/audit | redact + keys-only audit | output redacted pre-tag (pattern hits asserted: github-token); audit detail carries arg KEYS only (negative assertion on values) | ✅ accepted |
| T16 verify theater ("green means green") | — (moved up) | `recordVerify` cross-checks `test_results`/`security_findings`: green claims without rows, red latest rows, or open high/critical blockers are denied + audited; lifecycle e2e proves fail-closed → evidence → green | ✅ accepted |
| Browser fetch as SSRF conduit (new stub) | egress allowlist | 2-regime URL gate (explicit allowlist unlocks loopback, RFC1918/metadata otherwise blocked); non-allowlisted requests denied pre-flight (server-hit counter proves untouched); no redirect following; content-type allowlist; no JS by construction | ✅ accepted |

## 3. Definition-of-done spot check (P3.x sampling)

| Item | Check |
| --- | --- |
| P3.1 kernel funnel order | envelope → schema → preflight → jail gate → evaluate → execute(timeout/cap) → redact → tag → audit; approval gates verified side-effect-free (`sideEffect === 0` assertions) |
| P3.2 no-shell proof | adversarial suite green; env allowlist asserts `SSH_AUTH_SOCK`/parent-only secret vars absent from child env |
| P3.3 git tool = GitRunner only | no raw `git` in tools package; mutating subcommands approval-gated, approved-commit e2e green |
| P3.4 `--scans green` real | engine evidence cross-check (4-case suite incl. fix-unlocks-green) |
| P3.5 lint blocking | exit 0 sustained with repository-pinned versions (`eslint@10.10.0`, `typescript-eslint@8.70.0`) |

## 4. Deliberate deferrals (Phase 4+)

- `openai-responses`/`gemini` protocol adapters (Phase 2 backlog tail).
- Sandbox level 2 execution (bwrap/firejail wrappers consume the P3.2 markers).
- Desktop/UI wiring of tool approval UX (orchestration phase).
- `test.exec` verdict → `test_results` row persistence is caller-side (agent loop, Phase 4);
  the engine already refuses green claims without rows, so the wiring is enforced at the gate.

## 5. Decision

**Phase 3 complete.** Gate suite green, threat-model residuals accepted, policy matrix codified
as the preflight/request contract, lint gate real. Tag `phase-3-complete` on this commit;
Phase 4 (agents/investigator/planner/implementer consuming the tool registry) may open.
