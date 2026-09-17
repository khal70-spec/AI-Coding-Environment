# User Guide (placeholder — grows from Phase 1)

Planned guides (Plan §49): installation, projects, providers + API keys, model routing,
tasks + approvals, agents, MCP, skills, security + audit, local models, backup/recovery,
troubleshooting. The full guide ships with the Phase 7 desktop app.

Today (Phase 0): the repo is a security foundation + kernels. Operators can run:

```bash
npm test                 # unit + security + integration suites
npm run check:secrets    # offline secret scan
npm run db:migrate       # apply SQLite migrations (idempotent)
node apps/cli/src/cli.ts doctor
```
