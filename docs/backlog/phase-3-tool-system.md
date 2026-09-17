# Phase 3 — Tool system (Plan §54.8, §18, §22–24)

**Goal**: model-usable tools behind the policy engine. Every tool call is
allowlisted, sandboxed, redacted, and audited; the classifier decides what runs.
Tools are the last kernel the agents (Phase 4) consume.

**Entry state**: approved Phase 2 (`255/255`, tag `phase-2-complete`); policy kernel,
command classifier, redaction, path containment, git runner, provider dispatcher all live.

## P3.1 Tool kernel — DONE

- [x] `Tool` contract: `{ id, riskTier, schema(json), preflight(args) → verdict, run(ctx) }`;
  args schema-validated, output byte-capped + redacted, trust-tagged (untrusted model content)
- [x] Tool registry behind `permissions` table (effect rows audited); deny-by-default
- [x] `fs` tool (read/write/list inside containment jail; symlink-aware from Phase 1)
- [x] `search` tool (grep-style read-only)
- [x] Safe-edit: patch/structured-edit with rollback marker; never blind-full-file overwrite

## P3.2 Terminal tool + sandbox levels — DONE

- [x] Terminal tool fronting the command classifier (destructive → blocked; risky → approval gate)
- [x] Sandbox level 1 (cwd jail + argv-only + no network) end-to-end with tests
- [x] Sandbox level 2 markers (bubblewrap/firejail detection on linux; documented fallback gate)
- [x] No-shell / no-pipe / no-backtick enforcement proven by adversarial tests

## P3.3 Git + test-runner tools — DONE (verify-evidence wiring moves to P3.4)

- [x] Git tool = `GitRunner` surface only (no raw `git`); checkpoint/worktree primitives reused
- [x] Stack detection (`package.json`, `composer.json`, `*.csproj`, `requirements.txt`)
- [x] Test-runner tool: stack-allowlisted argv, normalized verdict + capped tail,
  output capped + redacted, timeout, cwd jail; **`verify` evidence integration → P3.4**

## P3.4 Security scanners + browser worker hooks — DONE

- [x] Semgrep/Gitleaks/OSV/Trivy adapters (argv-only, config-sanitized, output trust-tagged)
- [x] `--scans green` becomes real when any scanner runs: findings → `security_findings` rows
- [x] Browser worker (stub shape): egress-allowlisted fetch-by-policy, DOM text extraction,
  untrusted-content tagging — no JS execution in Phase 3

## P3.5 ESLint + close-out

- [ ] ESLint flat config + typescript-eslint (advisory→becomes blocking gate)
- [ ] Tests: policy matrix, injection attempts, sandbox escape attempts, path-jail attacks,
  output-cap redaction, `fs`/`terminal` contract suites, stack detection fixtures
- [ ] CLI surface updates; docs sweep; gate review + tag

**Done = policy-matrix green; adversarial terminal tests green; fs/search/git/test-runner
usable by next phase's agents; lint gate real; `verify --scans` can be end-to-end.**
