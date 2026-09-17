# Multi-Model AI Coding Environment — Production-Ready Build Plan

**Document:** `AI_Coding_Environment_End_to_End_Plan.md`
**Status:** FROZEN master specification (Phase 0 baseline, committed to repo 2026-09-17).
Frozen means: later implementation plans must map tasks back to this document and must
not silently remove security controls, verification stages, or required capabilities.
Changes require an ADR plus explicit threat-model/policy review.
**Target:** Production-ready local-first AI coding environment and multi-model agent orchestrator
**Primary UX goal:** A desktop coding workspace with the usability and workflow quality of Claude Desktop/Codex, while remaining provider-neutral and allowing any compatible AI model/API to be added.

---

## 1. Product Vision

Build one secure AI development environment that can work across many projects and programming stacks.

The user gives the system one task. The system should:

1. understand the task;
2. inspect the project before changing anything;
3. discover relevant files, dependencies, architecture, tests, instructions, and security constraints;
4. create a plan;
5. select the best model/agent for each subtask;
6. execute work in an isolated workspace;
7. run tests, linting, type checks, builds, and security checks;
8. independently review the changes;
9. repair failures;
10. re-test;
11. present a final diff, evidence, risks, and result;
12. require explicit approval for high-risk actions.

The system must never treat an LLM response as trusted code. Models are untrusted decision-makers operating through a controlled tool layer.

---

# 2. Product Positioning

The product is **not** another foundation model.

It is:

> **A secure, provider-neutral AI coding operating environment and agent orchestrator.**

It should support:

- OpenAI-compatible APIs;
- Anthropic-compatible APIs;
- NVIDIA NIM/API Catalog;
- Google/Gemini-compatible integrations where appropriate;
- local models;
- self-hosted OpenAI-compatible endpoints;
- MCP tools and servers;
- future providers without core-code rewrites.

NVIDIA NIM exposes OpenAI-compatible inference APIs including chat completions, responses, model listing, and an Anthropic-compatible messages endpoint, making a provider-adapter architecture practical.

---

# 3. Core Design Principles

## 3.1 Local-first

Project source code, credentials, logs, and agent state should remain local by default.

Cloud AI providers receive only the minimum context required for the current operation.

No project upload is allowed globally by default.

## 3.2 Provider neutral

Never hard-code business logic around one provider.

All providers implement a common internal interface.

## 3.3 Model neutral

A model is a configuration, not an architectural dependency.

Adding a model should normally require:

- provider configuration;
- model identifier;
- capabilities;
- limits;
- pricing/usage metadata;
- optional routing rules.

It should not require modifying the orchestrator.

## 3.4 Least privilege

Every agent receives only the tools and permissions required for its current task.

## 3.5 Plan before modify

For non-trivial work:

`discover -> inspect -> plan -> risk assessment -> checkpoint -> modify -> verify`

## 3.6 Independent verification

The agent that writes code must not be the only agent deciding that the work is correct.

## 3.7 Evidence over confidence

The UI must show test results, command results, changed files, security findings, and review evidence.

Never display "safe" merely because a model says it is safe.

## 3.8 Fail closed

If permission, policy, authentication, provider configuration, tool authorization, or security verification fails, the operation stops.

---

# 4. Desktop UX

The interface should feel familiar to users of modern AI desktop coding tools, but the architecture should remain independent.

## 4.1 Main application layout

```text
+--------------------------------------------------------------------------------+
| Project | Branch | Model | Agent Status | Usage | Security | Settings         |
+----------------------+--------------------------------------+------------------+
|                      |                                      |                  |
| PROJECTS             |              MAIN WORKSPACE         | CONTEXT / TOOLS  |
|                      |                                      |                  |
| Workspaces           | Chat / Task Conversation             | Files            |
| Threads              |                                      | Changes          |
| Runs                 | Plan / Progress / Results            | Tests            |
| Agents               |                                      | Security         |
| Models               |                                      | Logs             |
| Providers            |                                      | MCP              |
| MCP                  |                                      |                  |
| Skills               |                                      |                  |
+----------------------+--------------------------------------+------------------+
| Terminal | Problems | Test Results | Git Diff | Agent Events | Audit          |
+--------------------------------------------------------------------------------+
```

## 4.2 Required navigation

- Projects, Workspaces, Conversations, Tasks/Runs, Agents, Models, Providers,
  MCP / Tools, Skills, Files, Changes, Tests, Security, Git, Terminal,
  Logs/Audit, Schedules/Automation, Settings

## 4.3 Command palette

New Task, New Workspace, Select Model, Select Agent, Run Tests, Run Security Scan,
Review Changes, Open Git Diff, Roll Back Run, Add Provider, Add API Key, Add MCP Server,
Disable Tool, View Audit Log, Lock Workspace, Export Run Report.

---

# 5. Projects and Workspaces

A project is the persistent logical container. A workspace is an isolated execution
environment for a task. Support: multiple projects; multiple repos per project; monorepos;
Git worktrees; branches; task-specific workspaces; temporary scratch workspaces; archived workspaces.

## Required safety model

Never modify the user's primary working tree automatically for a complex task.

`main repository -> isolated worktree/branch -> agent changes -> tests -> review -> user approval -> merge`

Provide configurable exceptions for simple, low-risk tasks.

---

# 6. Global Instructions and Project Instructions

Priority: 1. System security policy 2. Organization policy 3. User global policy
4. Project policy 5. Workspace policy 6. Task instructions 7. Model-generated suggestions.

Lower layers must never override higher security policies. Support global, project,
directory-specific, agent, security, testing, and deployment instruction files.
Detect conflicting instructions and stop or request clarification rather than silently
choosing the unsafe interpretation.

---

# 7. Agent Architecture

Agents are specialized workers, not unrestricted autonomous processes.

- **Orchestrator:** classify, decompose, choose agents/models, enforce policies, coordinate, collect evidence.
- **Investigator** (default read-only): inspect architecture, code, deps, Git, tests, security implications.
- **Architect:** design solution, tradeoffs, implementation plan, migrations/compat.
- **Implementer:** modify approved files, implement, create/update tests, follow conventions.
- **Tester:** execute suites, analyze failures, regressions, add missing tests where authorized.
- **Security Reviewer:** auth, secrets, injection, file/command access, deps, SSRF/XSS/CSRF,
  traversal, deserialization, supply chain, prompt injection, tool abuse, exfiltration.
- **Code Reviewer:** independent final-diff review.
- **Documentation Agent:** docs only when authorized.
- **Release Agent:** release artifacts; cannot deploy without explicit deployment permission.

---

# 8. Agent Permission System

Permissions explicit and machine-enforced (investigator read-only; implementer workspace-scoped;
security reviewer inspects but cannot silently weaken protections). See §8 YAML examples in full text.

---

# 9. Dangerous Operations

Blocked by default: production deployment; production DB modification/deletion; `DROP DATABASE`;
destructive recursive deletion; credential rotation; disabling auth/authz/security middleware;
firewall changes; OS-level destructive ops; license-enforcement changes; payment-logic changes;
encryption changes; CI/CD secret changes; secret exposure; pushing to protected branches.

Require explicit approval showing exact command/action, target, expected impact, rollback plan,
affected files/resources.

---

# 10. Model Provider Architecture

Provider adapter interface: id, name, protocol, baseUrl, authentication, models,
capabilities, limits, health. Protocols: OpenAI Chat Completions, OpenAI Responses,
Anthropic Messages, Gemini, NVIDIA NIM, generic REST, local OpenAI-compatible endpoints.

---

# 11. API Key Management

Encrypted at rest; never plaintext in DB; never displayed after entry; never sent to an LLM;
never logged; secret redaction; clipboard protection; process/env isolation; rotation and
revoke support; provider scopes. Use OS credential stores (Windows Credential Manager/DPAPI,
macOS Keychain, Linux Secret Service/libsecret) with an encrypted app vault fallback.
Add providers without source-code changes via Settings → Providers → Add Provider.

---

# 12. Model Registry

Normalized per-model record: id, provider, capabilities (text/vision/audio/tools/structured
output/reasoning/code/long-context/streaming/parallel-tools/computer-use/embeddings/image-gen),
context window, status. Verify declared capabilities with capability tests — never trust blindly.

---

# 13. Model Router

Route by task type, language, project size, context needs, capabilities, latency, reliability,
budget, provider health, quality, user prefs, security sensitivity. Deterministic where possible;
the model must not freely choose another provider — the orchestrator decides per policy.

---

# 14. Multi-Model Collaboration

Sequential, parallel, debate, voting, and escalation (start cheap, escalate on uncertainty,
failures, findings, retries, complexity) modes.

---

# 15. Context Engine

Assemble per-agent context via repo map, symbol index, dependency graph, semantic/exact search,
Git history, tests, docs, task context, prior runs. Never blindly send whole repos.
Pre-send secret filtering: keys, passwords, tokens, private keys, connection strings,
certificates, env secrets, PII — redact unless explicitly authorized.

---

# 16. Prompt-Injection Defense

Treat repo/web/issue/doc/comment/tool content as untrusted data. Implement trust labels,
instruction-source hierarchy, tool-output isolation, secret filtering, suspicious-instruction
detection, confirmation gates for external actions.

---

# 17. MCP Architecture

First-class MCP for GitHub/GitLab, DBs, browsers, cloud, trackers, docs, internal/local tools.
MCP servers are untrusted: identity, trust level, permissions, allowed tools/resources, network
policy, credentials, audit logging. Follow the current MCP authorization spec (HTTPS, PKCE,
protected resource metadata, token security) — never invent weaker auth.

---

# 18. Tool Security

Every tool call passes the policy engine: allowed → execute; approval → ask user; denied → block.
Shell execution: parse → classify risk → validate cwd/env → allow/deny → sandbox → execute →
capture → redact → audit. Never execute raw model-generated commands directly.

---

# 19. Sandboxing

Level 1 project sandbox (workspace fs), Level 2 OS sandbox (process/fs/net/creds),
Level 3 disposable VM/container for high-risk commands. Containers alone are not assumed safe.

---

# 20. Network Security

Default `DENY`. Allowlist only (registries, Git provider, configured AI provider, docs,
approved test endpoints). Block localhost attacks, private-IP probing, cloud metadata,
port scanning, DNS rebinding, unexpected redirects, unauthorized uploads. SSRF protection.

---

# 21. Git Safety

Checkpoint before modify (`status → diff → checkpoint → isolated worktree`); capture
commit/branch/base SHA/files/agent/model/tool actions. Support diff/revert/rollback/
cherry-pick/merge/branch-cleanup. Never destroy uncommitted user changes.

---

# 22. Testing Pipeline

Detect stack and run gated suites: .NET (build/tests/analyzers/audit), Laravel/PHP
(Composer/Pest/static analysis), React/TS (typecheck/lint/unit/Playwright/build), Python
(pytest/mypy/ruff/audit). User-configurable project gates.

---

# 23. Security Pipeline

Semgrep, Gitleaks, OSV/deps, Trivy, OWASP ZAP, native analyzers, secret scanning, SAST,
dependency audit — all evidence-producing.

---

# 24. Browser and UI Testing

Isolated browser worker: dev server, navigation, dedicated test accounts, screenshots,
Playwright, responsive, console/network error detection. Never production credentials.

---

# 25. Agent Memory

Separate global prefs, project knowledge, task history, model observations, scratchpad.
No cross-project leakage. Memory needs visibility, deletion, export, retention policy.

---

# 26. Audit System

Log: login/unlock, provider added, key changed, model selected, tool/MCP/permission changes,
shell/file/network actions, approvals/denials, deploys, rollbacks. Never log raw secrets
or full sensitive file contents.

---

# 27. Authentication and Local Security

OS account binding, optional app passcode, OS-credential storage, session lock, idle timeout,
encrypted sensitive state, secure IPC, signed updates, tamper detection. Future server mode
gets full RBAC + server-side authorization.

---

# 28. Desktop IPC Security

Isolate renderer, no unnecessary Node access, strict IPC allowlists, validate every message,
never run renderer-provided shell directly, origin restrictions, protocol/path-traversal
protection, OS credential storage. Small privileged backend, unprivileged UI.

---

# 29. Recommended Technical Architecture

`Desktop UI (React+TS) → Tauri 2.x shell → Local core (Rust + TS services) → providers,
orchestrator, policy, tools, context, git/workspace, security, MCP, audit`.
Electron+TS acceptable if security model is carefully designed; evaluate Tauri first.

---

# 30. Data Storage

SQLite for local state (projects, workspaces, conversations, tasks, runs, agents, models,
providers, MCP, permissions, audit, test results, findings). Secrets in OS store/encrypted
vault. Large indexes via SQLite FTS/vector as appropriate.

---

# 31. UI Screens

Home, Project, Chat, Run, Models, Providers, Agents, Security, MCP.

---

# 32. Task State Machine

```text
CREATED → CLASSIFYING → INVESTIGATING → PLANNING → WAITING_APPROVAL
→ PREPARING_WORKSPACE → IMPLEMENTING → TESTING → SECURITY_REVIEW
→ AI_REVIEW → FIXING → VERIFYING → READY → APPROVED → MERGED
Failure: BLOCKED / CANCELLED / FAILED / ROLLBACK_REQUIRED
```

---

# 33. Approval Model

Low risk (docs/formatting/simple tests) may auto-run. Medium (app code, deps, schema) needs
plan approval or configured auto-approval. High (auth/payments/crypto/prod/secrets/destructive/deploy)
needs explicit approval.

---

# 34. Model Reliability

Track task success, test pass rate, review rejections, retries, latency, tokens, cost,
provider errors, hallucination indicators, security findings. Improve routing; never silently
prefer cheap over safe.

---

# 35. Provider Failover

Ordered fallback on failure; never silently send sensitive context to unapproved providers;
fallback obeys data classification.

---

# 36. Data Classification

Public / Internal / Confidential / Restricted. Restricted → local-only; Confidential →
approved providers; Internal → approved cloud; Public → any enabled provider.

---

# 37. Cost Controls

Per-provider/model budgets, daily/monthly token limits, max context/agents/retries,
escalation budgets. Show estimated/actual usage.

---

# 38. Offline Mode

Without cloud AI: browsing, Git, local tools, tests, scans, local models, docs, history.
The environment must not break.

---

# 39. Local Model Support

Ollama, LM Studio, vLLM, local NIM, future local OpenAI-compatible runtimes.

---

# 40. Skills System

Versioned `skills/<name>/` packages: description, instructions, tools, permissions,
validation, version, review status. Untrusted extensions; no silent privilege elevation.

---

# 41. Plugin System

Providers/tools/MCP/skills/UI panels via plugins with identity, signature, integrity,
permissions manifest, source, version, deps, security review.

---

# 42. Updates

Signed updates: publisher, signature, checksum, version, rollback compat. Never silent
unsigned updates.

---

# 43. Telemetry

Default OFF. Minimal ops metrics only; never source, keys, or conversation content by default.

---

# 44. Threat Model

20 threats: malicious repo instructions, prompt injection, malicious MCP/skill/plugin,
stolen keys, compromised provider, malicious deps, command injection, traversal, SSRF,
exfiltration, hallucination, confused deputy, privilege escalation, compromised process,
supply chain, malicious browser content, unsafe automation, accidental destruction,
cross-project leakage. Each needs mitigation, test, owner, residual risk.

---

# 45. Security Standards

OWASP ASVS/Top 10/LLM Top 10/Agentic guidance, OAuth 2.1, MCP security/authorization specs,
CWE/CVE/OSV, SLSA/SBOM.

---

# 46. Testing Strategy

Unit (policy/router/adapters/redaction/classifier/filtering), integration (provider/Git/fs/
MCP/terminal/browser/SQLite), security (traversal/injection/leakage/SSRF/bypass/IPC/plugin/
MCP/token), E2E (`task → plan → approval → implement → test → review → rollback`).

---

# 47. CI/CD

Every PR: build, unit/integration tests, lint, typecheck, dep audit, SAST, secret scan,
SBOM, integrity checks. Release: `source → test → security → signed build → verify → release`.

---

# 48. Repository Structure

See `README.md` (kept in sync with this section).

---

# 49. Documentation Requirements

README, architecture, threat model, security model, provider/routing/agent/MCP/plugin/skill/
API-key/local-model/testing/release/incident/backup/user/admin guides. All arch/security
decisions as ADRs.

---

# 50. Development Phases

Phase 0 foundation → 1 core runtime → 2 providers → 3 tools → 4 agents → 5 context/routing →
6 MCP/skills → 7 desktop UI → 8 hardening → 9 production readiness. **No full UI before Phase 7.**

---

# 51. Definition of Done

No critical/high vulns; secure keys; redaction; gated danger; isolated workspaces; Git rollback;
failover; routing; independent review; mandatory tests/scans; MCP/plugin permissions; tested
injection defenses/isolation/IPC; signed builds; upgrade/rollback; audit; complete docs.

---

# 52. Initial Model Strategy

Small initial set, unlimited expansion. NVIDIA (Kimi K3, DeepSeek, GPT-OSS, current),
Anthropic (current Claude APIs), OpenAI (current GPT/Codex APIs), local
(Ollama/LM Studio/vLLM/local endpoints). No hard-coded model names in core; registry
supports discovery/versioning.

---

# 53. First Release Target

> One desktop app: open project → connect providers → encrypted keys → auto routing →
> task → plan → approve → isolated agents implement → tests/security → diff → rollback.

---

# 54. First Implementation Order

1. Repo+ADR 2. Threat model 3. Security policy 4. Secret vault 5. SQLite schema
6. Workspace manager 7. Git safety 8. Tool permissions 9. Provider abstraction
10. Adapters 11. Registry 12. Agent abstraction 13. State machine 14. Investigator
15. Planner 16. Implementer 17. Test runner 18. Security reviewer 19. Reviewer
20. Context engine 21. Router 22. MCP 23. Skills/plugins 24. Shell 25. UI
26. E2E 27. Hardening 28. Signed builds.

---

# 55. Non-Negotiable Rules

1. Never expose provider API keys to models. 2. Never trust repo instructions as system
instructions. 3. Never let models bypass policy. 4. Never run shell without policy.
5. Never auto-modify production. 6. Never destroy user changes. 7. Never send restricted
data to unapproved providers. 8. Never log secrets. 9. Never let skills/plugins silently
elevate. 10. Never give MCP servers unrestricted access. 11. Never claim success without
evidence. 12. Never sole-review by implementer. 13. Never merge failing/unverified changes.
14. Always keep auditable history. 15. Always provide rollback where technically possible.

---

# 56. Success Criteria

Install → open project → add keys → "Implement this feature" → system performs
`understand → investigate → plan → select models → isolate → implement → test →
security review → independent review → fix → verify → present final diff`.

---

# 57. Immediate Next Step

1. Freeze architecture ✅ (this file) 2. Create repo ✅ 3. `CLAUDE.md`/`AGENTS.md`/
instruction hierarchy ✅ 4. Threat model 5. Security ADRs 6. Provider-interface ADR
7. Agent-permission ADR 8. Workspace-isolation ADR 9. MCP-security ADR 10. Secret-storage ADR
11. State-machine ADR 12. Initial backlog 13. Begin Phase 0 implementation.
