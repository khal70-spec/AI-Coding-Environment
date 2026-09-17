# Getting Started (developers)

## Prerequisites

- Node.js ≥ 22.18 (`node --version`) — tests and the CLI execute TypeScript directly via
  type-stripping, which is flag-free from 22.18 on. Node 24 LTS recommended.
- Git
- No other toolchain needed for Phase 0 (zero runtime dependencies; the migration
  runner uses built-in `node:sqlite` — no `sqlite3` CLI required).

## First run

```bash
npm install
npm test                 # unit + security + integration tests
npm run test:workspaces  # each package's own suite (must show non-zero pass counts)
npm run check:secrets    # must pass before every commit/PR
npm run audit:deps       # must be clean at high+ severity
npm run db:migrate       # applies packages/storage/migrations (idempotent)
```

## Layout conventions

- One npm workspace per `packages/*` and `apps/*`; ESM + `strict` TS.
- Pure logic lives in `src/*.ts` compiled without bundlers; tests use `node --test`
  and import from `src` directly (TS via type-stripping on Node ≥ 22.18).
- `node --test` exits 0 on zero matches — a per-package glob that matches nothing is
  silently green, so check pass counts when adding packages (the CI root run is the
  authoritative count).
- Security kernels (`policy`, `security`, `secrets`, `git` safety) must stay dependency-free.
- New package? Add `package.json` + `README.md` (concept doc) + backlog entry. Prefer
  extending an existing package.

## Adding a test

```bash
# unit
tests/unit/<package>/<name>.test.mjs
# security (must include at least one expected-block/expected-deny case)
tests/security/<name>.test.mjs
# integration (real fs/SQLite/git — no external services)
tests/integration/<area>/<name>.test.mjs
node --test tests/unit/<package>/ tests/security/
```

Fixtures must be synthetic with fake markers (`TESTONLY`, `EXAMPLE`, `<redacted>`, …).

## Useful scripts

| Command | Purpose |
|---|---|
| `npm test` | all tests (unit + security + integration) |
| `npm run test:workspaces` | per-package suites |
| `npm run check:secrets` | offline secret scan of tracked files |
| `npm run audit:deps` | `npm audit` at high+ |
| `npm run lint` / `npm run typecheck` | honest no-ops in Phase 0; real configs land in Phase 1 |
| `DB_PATH=./.local/app.db node scripts/db-migrate.mjs` | apply SQL migrations (idempotent; driver swap per ADR-008 in Phase 1) |
