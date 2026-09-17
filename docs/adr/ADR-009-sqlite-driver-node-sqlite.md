# ADR-009: SQLite driver — built-in `node:sqlite` (Phase 1)

- **Status:** accepted
- **Date:** 2026-09-17
- **Plan refs:** §30, §47
- **Threats:** T7
- **Implements the driver choice deferred by:** ADR-008

## Context

ADR-008 deferred the driver choice (`better-sqlite3` vs `node:sqlite`) to Phase 1 with a
build-matrix check. Phase 1 needs typed DAOs, a boot-path migrator, and an offline CLI.

## Decision

Use the **built-in `node:sqlite` (`DatabaseSync`)** as the storage driver:

- engines floor is already Node ≥ 22.18, and `node:sqlite` ships ≥ 22.5 — zero added
  runtime dependencies (dependency-policy rule 1: prefer `node:` builtins, T7);
- synchronous API matches the fail-closed, sequential orchestration model;
- the CLI matrix (Node 22 + 24) is the build-matrix check ADR-008 required;
- `SqliteDb` structural interface (`packages/storage/src/migrate.ts`) isolates the
  driver behind typed DAOs, so a later swap to `better-sqlite3` (native perf, older-Node
  support) touches one module, not call sites — schema SQL stays driver-neutral.

Known trade-off accepted: `node:sqlite` prints an ExperimentalWarning on Node 22
(stable API on 24). Dev-tooling/CI only; revisited at Phase 9 (production readiness).

`better-sqlite3` was evaluated: adds a native build dependency + supply-chain surface
for no Phase-1 feature gain. Rejected for now without prejudice.

## Consequences

- `packages/storage`: `migrate.ts` (shared runner), `database.ts` (boot path), `dao.ts`
  (typed DAOs; audit append-only); `scripts/db-migrate.mjs` is a thin wrapper over the
  shared runner — migration logic exists exactly once.
- Tests: live-DB unit tests (`tests/unit/storage/dao.test.mjs`), lifecycle integration
  (`tests/integration/cli-lifecycle.test.mjs`), idempotency (`tests/integration/storage/`).

## Alternatives considered

- **`better-sqlite3`**: fastest native binding; rejected this phase (native build, new
  dependency) — structural interface keeps the door open.
- **sql.js / wasm**: portable but in-memory + manual persistence; rejected for a
  local-first durable store.

## Security considerations

Parameterized statements only (no value interpolation); foreign keys pinned on open;
`audit_events` append-only enforced by DAO shape + source-scan test; no secret values
— `provider_credentials.vault_ref` references only (T5). Driver adds zero packages (T7).
