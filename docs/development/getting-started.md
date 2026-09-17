# Getting Started (developers)

## Prerequisites

- Node.js ≥ 20 (`node --version`)
- Git
- No other toolchain needed for Phase 0 (zero runtime dependencies).

## First run

```bash
npm install
npm test                 # all workspace unit + security tests
npm run check:secrets    # must pass before every commit/PR
npm run audit:deps       # must be clean at high+ severity
```

## Layout conventions

- One npm workspace per `packages/*` and `apps/*`; ESM + `strict` TS.
- Pure logic lives in `src/*.ts` compiled without bundlers; tests use `node --test`
  and import from `src` (TS via type-stripping on Node ≥ 22, or compiled `dist/`).
- Security kernels (`policy`, `security`, `secrets`, `git` safety) must stay dependency-free.
- New package? Add `package.json` + `README.md` (concept doc) + backlog entry. Prefer
  extending an existing package.

## Adding a test

```bash
# unit
tests/unit/<package>/<name>.test.mjs
# security (must include at least one expected-block/expected-deny case)
tests/security/<name>.test.mjs
node --test tests/unit/<package>/ tests/security/
```

Fixtures must be synthetic with fake markers (`TESTONLY`, `EXAMPLE`, `<redacted>`, …).

## Useful scripts

| Command | Purpose |
|---|---|
| `npm test` | all workspace tests |
| `npm run check:secrets` | offline secret scan of tracked files |
| `npm run audit:deps` | `npm audit` at high+ |
| `DB_PATH=./.local/app.db node scripts/db-migrate.mjs` | apply SQL migrations (Phase 1+) |
