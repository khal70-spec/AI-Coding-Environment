# Tech Stack (Plan §29, ADR-001)

## Phase 0–6: TypeScript service core (this repo state)

- **Language**: TypeScript 5.x, `strict`, ESM (`"type": "module"`).
- **Runtime**: Node.js ≥ 22.18 (dev/test/CI) — sources and tests are executed directly
  via flag-free type-stripping. Production desktop embeds via Tauri sidecar/WebView.
- **TS config**: `tsconfig.base.json` is `noEmit` + `allowImportingTsExtensions`
  (typecheck-only base); emit settings (`declaration`, `sourceMap`, `outDir`) are added
  by per-package configs when compiled packages arrive in Phase 1.
- **Tests**: `node --test` + `node:assert/strict` (zero-dep unit/security tests).
  Playwright/Vitest arrive with Phases 3/7; no heavy harness before it is needed.
- **Storage**: SQLite schema + migrations in `packages/storage` (ADR-008). Migrations in
  `migrations/*.sql` are the single source of truth; `schema.sql` is a byte-exact mirror
  enforced by a drift-guard test. Migration runner uses `node:sqlite` (zero-dep);
  production driver (`better-sqlite3`/`node:sqlite`) selected in Phase 1.
- **Secrets**: OS keychain adapters + encrypted vault fallback (ADR-006);
  Phase 0 ships interface + redaction, OS bindings in Phase 2.
- **Lint/format**: ESLint + Prettier configs land in Phase 1 with first compiled packages.

## Phase 7: Desktop shell

- **Primary**: Tauri 2.x + React + TypeScript (ADR-001). Small privileged backend,
  unprivileged renderer, strict IPC allowlist, OS credential storage, signed updates.
- **Fallback**: Electron + TypeScript only if Tauri cannot meet a proven requirement;
  requires new ADR + full §28 control mapping.

## Rust boundary (later phases)

Rust enters for: Tauri commands, process sandboxing helpers, vault crypto helpers,
and hot paths (indexing) — behind narrow, audited interfaces. No ad-hoc Rust until an ADR.

## Dependency rules

See `docs/security/dependency-policy.md`. Highlights: minimal deps, lockfile, `npm audit`
gate, OSV + Semgrep in CI, SBOM from Phase 8, no telemetry/system-access packages without ADR.
