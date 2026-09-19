# Tests

- `unit/<package>/` — kernel behavior (happy path + edges), `node --test`.
- `integration/` — real fs/SQLite/Git with no external services (today: migration
  runner + full CLI task lifecycle over a real git repo; provider/fs/MCP/terminal
  coverage from Phase 2–3).
- `security/` — adversarial cases: every file must contain expected-block/deny cases.
- `e2e/` — full `task → plan → approval → implement → test → review → rollback` (Phase 4+).

Fixtures are synthetic with fake markers (`TESTONLY`, `EXAMPLE`, `<redacted>`).
Run: `npm test` (all layers); per-package: `npm run test:workspaces`.
