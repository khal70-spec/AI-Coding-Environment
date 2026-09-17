# `@ai-coding-env/tools`

Tool system kernel (Phase 3 — Plan §18/§19/§22). Every tool call flows through
one funnel, `ToolRunner.call()`:

```
envelope validate → registry lookup → arg schema validate → preflight hints
→ jail gate (cwd containment) → policy.evaluate → deny | approval | allow
→ execute (timeout + byte cap) → redact → trust-tag → audit
```

Denials and approval gates never execute the tool. Approval evidence (Phase 4)
re-calls with `ToolContext.approved: true`, which shortens only the
*dangerous/high-risk* gates — hard denies (neverAllow, workspace lock, allowlist,
scope, classification, network) are unaffected.

## Contract (`src/runtime.ts`)

`Tool = { id, description, defaultRisk, argsSchema, preflight(args, ctx) →
PreflightHints, run(args, ctx) → string }`. Schemas reject unknown args and NUL
bytes. `PreflightHints` shape the policy request: `fsScope`/`fsReadScope`,
`networkHost`, `dangerous`, `neverAllow`, `riskOverride`. Output is byte-capped
(`TOOL_MAX_OUTPUT_BYTES = 256 KiB`), pass-through `redact()`, then wrapped in
untrusted-content markers (`<<<UNTRUSTED-TOOL-OUTPUT tool="…">>>`). Audit events
carry actor, tool, arg **keys** — never arg values.

`ToolContext.jailRoot` is required; all fs paths and all terminal cwd values
must prove containment through the Phase 1 kernel (lexical + deepest-existing-
ancestor realpath, `assertContainedSync`).

## Executors

| ID | Notes |
| --- | --- |
| `fs.read` | ≤ 4 MiB (partial reads past 256 KiB), binary/NUL files refused |
| `fs.list` | depth ≤ 2, ≤ 500 entries, out-of-jail symlinks marked not followed |
| `fs.write` | new file: allow; overwrite / secret-shaped content: **approval**; escape: **deny** |
| `fs.edit` | literal search/replace (never regex); unique-match by default, ambiguous refuses; **approval** |
| `fs.search` | bounded regex search (10k files, 200 results), skips binaries + vendor dirs |
| `terminal.exec` | argv-only spawn — **no shell ever**; destructive shapes **deny**, risky **approval** |
| `git.exec` | Phase-1 GitRunner surface only; read-only → low risk, mutating → approval, blocked shapes → deny |
| `test.exec` | stack-detected allowlisted test argv; normalized pass/fail/timeout verdict + capped tail |

## `terminal.exec` guarantees (sandbox level 1)

- argv-only via `spawn` — pipes/backticks/`$(...)` are inert *data* (tested
  adversarially), never interpreted.
- `argv[0]` must be a bare name: no `/`, `..`, shells, or interpreter eval flags
  (`node -e`, `python3 -c`, …) — hard deny.
- classifier verdicts: `blocked → neverAllow`, `high → approval`, `medium/low →
  risk` flowing into policy.
- cwd jailed inside the workspace; sanitized env allowlist (`PATH`, `HOME=jail`,
  `LANG`, `LC_ALL`, `TERM`, `AICE_SANDBOX=1`); **no inherited secrets**.
- `stdin: "ignore"`; detached process group — timeout (≤ 10 min) and output-cap
  kill the whole group (SIGTERM → SIGKILL).
- **Known limitation (documented)**: level 1 cannot block outbound *network*
  from a child at the OS layer; that lands with level 2 (`sandbox-detect.ts`
  reports bwrap/firejail availability as `sandbox-level-2` markers).

## Stacks + sandbox detection

`src/stack-detect.ts` — read-only project sniffing (`detectStack`) used by
`test.exec`; the emitted argv is the ONLY thing the test tool can run.

## Sandbox detection (`src/sandbox-detect.ts`)

Read-only PATH/env scan (no execution): `detectSandbox()` → `{ maxLevel, bwrap,
firejail, containerized, flatpak }`; `sandboxMarker()` for doctor/audit rows.

Backlog: `docs/backlog/phase-3-tool-system.md` (P3.1/P3.2 complete).
