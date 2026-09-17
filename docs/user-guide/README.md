# User Guide (placeholder — grows from Phase 1)

Planned guides (Plan §49): installation, projects, providers + API keys, model routing,
tasks + approvals, agents, MCP, skills, security + audit, local models, backup/recovery,
troubleshooting. The full guide ships with the Phase 7 desktop app.

Today (Phase 1): operators can run the full offline core through `aice`:

```bash
npm test                 # unit + security + integration suites
npm run check:secrets    # offline secret scan
npm run db:migrate       # apply SQLite migrations (idempotent)
node apps/cli/src/cli.ts help      # projects, tasks, approvals, workspaces, audit
```

A first end-to-end walkthrough (create project → task → approve → isolated worktree →
advance the machine → verify → review → merge) is in
[`docs/development/getting-started.md`](../development/getting-started.md#operator-cli-tour-phase-1-fully-offline).
