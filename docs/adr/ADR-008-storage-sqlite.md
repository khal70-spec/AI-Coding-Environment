# ADR-008: Local storage — SQLite + versioned migrations

- **Status:** accepted
- **Date:** 2026-09-17
- **Plan refs:** §25, §26, §30
- **Threats:** T5, T20

## Context

Local-first state (projects → audit) needs a durable, queryable, offline store with no
server dependency. Secrets must never live in ordinary tables.

## Decision

**SQLite** (WAL mode) with forward-only versioned migrations in
`packages/storage/migrations/*.sql`, applied by `scripts/db-migrate.mjs` (Phase 0)
and the app boot path (Phase 1+). Tables: projects, workspaces, conversations, tasks,
runs, agents, models, providers (+ credential **refs**), mcp_servers, permissions, audit
events, test results, security findings. Full-text search via FTS5; vector index later
only if retrieval quality demands it (separate ADR).

Driver choice (`better-sqlite3` vs `node:sqlite`) happens in Phase 1 with a build-matrix
check; schema SQL stays driver-neutral.

## Consequences

- `packages/storage`: `schema.sql` baseline + migration runner + typed DAO helpers (Phase 1).
- Audit store is append-only by convention + tests (no UPDATE/DELETE paths in DAOs).
- Backup = copy DB file + export vault refs manifest (values re-entered or re-derived).

## Alternatives considered

- **JSON files**: rejected — no transactions, no queries, corruption-prone.
- **Postgres/server DB**: rejected — violates local-first/offline for v1; server mode later (ADR).

## Security considerations

No secret values in tables (T5) — enforced by schema review + DAO tests. Per-project
scoping columns + tests prevent cross-project leakage (T20).
