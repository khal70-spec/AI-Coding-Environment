# `@ai-coding-env/cli` — `aice`

Operator/CI CLI. Fully offline (Plan §38): no network is ever used. Requires
Node.js ≥ 22.18 (runs TypeScript via flag-free type-stripping).

```bash
node apps/cli/src/cli.ts doctor          # environment self-check
node apps/cli/src/cli.ts help            # full command surface
```

## Surface (Phase 1)

| Area | Commands |
|---|---|
| Environment | `version`, `help`, `doctor`, `migrate` |
| Projects | `project create\|list\|archive` |
| Tasks (state machine) | `task create\|list\|show\|advance\|fail` |
| Approvals (Plan §33) | `approve plan\|final <id> --by <actor>` |
| Evidence | `checkpoint <id>`, `verify <id> --tests … --scans …`, `review <id> --by <agent>` |
| Workspaces (ADR-004) | `workspace prepare\|list\|remove` |
| Audit | `audit --task ID \| --project ID` |
| Providers (ADR-002/010) | `provider add\|list\|remove\|test`, `provider key set\|remove\|status` |
| Models (Plan §12) | `model list\|discover\|probe` |
| Budgets (Plan §13) | `budget set\|list\|events\|remove` |

Global flags: `--db PATH` (env `DB_PATH`, default `.local/app.db`), `--by ACTOR`
(recorded in runs/audit), `--json` (machine output on `create`/`list`/`show`/`audit`).

Semantics worth knowing:

- Every `task advance` is guard-checked; **denials exit 1 and are audited** — the CLI
  is usable directly as a CI gate.
- `workspace prepare` walks the read-only phases, enforces the plan-approval gate,
  records a checkpoint, then creates an isolated git worktree under
  `<project>/.aice/worktrees/` (add `.aice/` to the project's `.gitignore`).
- `task show` prints state + run history + redacted audit trail.
- `provider key set` reads the key **from stdin only** — never argv/files (T5);
  `provider add` egress-validates the endpoint at registration; every provider
  dispatch passes the classification gate → egress gate → outbound secret gate; spend
  budgets hard-block when a window limit is reached (`budget events` is the ledger).

Tests: `tests/unit/cli/`, `tests/integration/cli-lifecycle.test.mjs`,
`tests/security/cli-shell-safety.test.mjs`.
