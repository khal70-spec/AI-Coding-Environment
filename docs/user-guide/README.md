# User Guide

Planned guides (Plan §49): installation, projects, providers + API keys, model routing,
tasks + approvals, agents, MCP, skills, security + audit, local models, backup/recovery,
troubleshooting. The full guide ships with the Phase 7 desktop app.

## Today: the offline core + governed agents (Phases 1–4)

```bash
npm test                 # unit + security + integration suites
npm run check:secrets    # offline secret scan
npm run db:migrate       # apply SQLite migrations (idempotent)
node apps/cli/src/cli.ts help      # full command surface
```

A first end-to-end walkthrough (create project → task → approve → isolated worktree →
advance the machine → verify → review → merge) is in
[`docs/development/getting-started.md`](../development/getting-started.md#operator-cli-tour-phase-1-fully-offline).

## Running a governed agent on a task (Phase 4)

```bash
# 1. See the agent manifests (grants + tool allowlists)
aice agent list

# 2a. Offline replay (deterministic): script-file transport (paragraph = one model turn)
aice agent run <task-id> --phase investigate --script-file ./script.txt

# 2b. Real model via a registered provider (keys stay in the vault, never argv):
aice agent run <task-id> --phase plan --provider <id> --model <id>
# or AICE_AGENT_PROVIDER=… AICE_AGENT_MODEL=… aice agent run <task-id> --phase implement

# 3. Agent sessions persist as agent_runs rows (+ .aice/agent-runs/ artifacts):
aice task inspect <task-id>
```

Rules of the lane:

- The **jail** is the task's active isolated workspace (else the project root); every
  tool call is policy-evaluated before it executes.
- Phases chain through persisted notes: `plan` reads the newest `investigate` note,
  `implement` reads the newest `plan` note; `--prompt` overrides the task text.
- Anything already gated by policy (overwrite, mutating git, approval commands) stalls
  the run as `awaiting-approval` (exit 1, zero side effects). After recording Plan §33
  evidence (`aice approve plan <id>`), resume with `--approved`.
- `--rounds N` caps model↔tool iterations (default 12, hard max 64) — a runaway model
  clamps, never loops forever.

## Context & routing (Phase 5)

```bash
aice context build <task-id> [--prompt T] [--budget N]   # index → rank → pack into .aice/context/
aice route <task-id> [--prompt T]                        # deterministic model decision for the task
```

- The index walk never follows symlinks and excludes secret-prone paths at the door
  (`.env`, `secrets/`, key material) — those files are recorded as skipped instead.
- Packed chunks are capped + secret-redacted before they count; audit hashes are of
  the admitted (redacted) text.
- Routing is a pure rule table: data classification clearance first (restricted ⇒
  local providers only), then risk, then kind, then cost — ties resolve on ids, and
  every decision prints its rationale. Empty pool ⇒ exit 1, never a silent fallback.

## MCP servers & skills (Phase 6)

```bash
# MCP: register a contained server (stdio or loopback/HTTPS http)
aice mcp add --name echo --transport stdio --command "/usr/bin/node,/path/server.js" \
             --tools-allow echo,get_time [--tools-deny …] [--network-allow host:port,…]
aice mcp list / invoke <id> --tool T --args-json '["…"]' / enable|disable|remove <id>

# Skills: register → review (consent surface) → approve (tamper-checked) → gate
aice skill add <path>        # digest + manifest registered as pending_review
aice skill review <id>       # shows digest + declared permissions — read before approve!
aice skill approve <id>      # re-digests live bundle; ANY mismatch blocks it
aice skill gate <id>         # exit 0 only when approved + digest matches
```

Truths you can rely on:

- Wildcards are forbidden everywhere; empty allowlists are default-deny.
- `http` MCP servers must be loopback (https for remote); endpoint `networkAllow`
  entries pin exact host:port; kill switch is per server.
- Permission rows (`mcp:<id>`/`skill:<name>`) can only tighten grants — never loosen.
- Skill digests cover path names AND bytes; a one-byte edit flips to blocked.

## Governed desktop UI (Phase 7)

The control surface sits behind a hardened bridge (`packages/ui` allowlist —
**nothing unlisted is reachable; the UI cannot self-attest governance evidence**):

```bash
DB_PATH=.local/app.db BRIDGE_ACTOR=alice npm run desktop
# → http://0.0.0.0:<port> (binds 0.0.0.0; restrict with BRIDGE_ALLOWED_HOSTS="...")
```

- **Projects / Tasks** — create + advance the ADR-007 lifecycle; every mutation funnels
  through the TaskEngine with audit; illegal transitions return `ENGINE_*` denials and
  never touch the DB row.
- **Approvals** — plan/final approvals unlock exactly one brake each; checkpoint /
  verify / review evidence is CLI/agent-only (no bridge command exists for it).
- **Agent sessions** — transcripts render display-only (redacted, bounded, inert text).
- **MCP / Skills** — visibility + enable/disable; consent and tamper paths stay on
  `aice mcp` / `aice skill` (CLI bridge lanes write the audit).
- **Audit** — content-free, append-only, redacted detail.

Preview hosts (arena/sandbox): set `BRIDGE_ALLOWED_HOSTS="e2b.app"` — foreign hosts get
`403 HOST_DENIED` structurally. See `docs/development/phase-7-gate-review.md`.
