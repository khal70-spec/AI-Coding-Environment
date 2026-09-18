# Desktop app (Phase 7 — hardened bridge POC)

**Status:** Phase 7 control-surface POC — a dependency-free **Node HTTP bridge
kernel + vanilla ES-module SPA** while Tauri 2.x + React (ADR-001) is the settled
target for the packaged desktop product.

## Architecture (Plan §28 posture)

```
SPA (apps/desktop/web)   ── POST /api/bridge ──>   bridge server (apps/desktop/src/server.ts)
  textContent-only (never innerHTML)                 │ Host gate · 64KB body cap · JSON-only
                                                     │ POST-only · stable error lanes
                                                     ▼
                                        packages/ui BridgeRegistry (allowlisted commands,
                                        pinned arg schemas, no prototype-chain lookups)
                                                     ▼
                             storage DAOs + TaskEngine — the ONLY lanes into the state
                             (evidence self-attestation commands simply do not exist)
```

## Hardening invariants (enforced + tested in `tests/unit/desktop/`)

- Bridge command allowlist — anything unlisted is structurally unreachable (UNKNOWN_COMMAND).
- Args: strict per-command schema (type/max/pattern/enum), unexpected args denied, `__proto__`
  / `constructor` keys rejected, never coerced.
- Evidence lanes (checkpoint/verify/review/sql) have **no bridge command** — the UI can
  never self-attest governance evidence; it goes through CLI + agent minds only.
- Server: host allowlist (preview hosts when `BRIDGE_ALLOWED_HOSTS` set), POST-only API,
  64KB JSON cap with delivered 413 (never a silent socket kill), control-byte reject,
  path whitelist + traversal-proof static serving, strict CSP/nosniff/frame-DENY,
  `no-store` API responses, no CORS headers (same-origin by construction).
- Transcripts/config JSON cross the wire **bounded + secret-redacted** (`redact`, ≤20KB),
  and the UI renders them with `textContent` only (display-only untrusted).
- Mutations travel `bridge → TaskEngine` (audit invariant never bypassed); illegal
  transitions land as `HANDLER_FAILED` with `ENGINE_*` codes and the DB row is untouched.

## Run (dev/preview)

```bash
DB_PATH=.local/app.db BRIDGE_ACTOR=operator \
  BRIDGE_ALLOWED_HOSTS="localhost,127.0.0.1"   npm run desktop
# bridge + SPA at http://0.0.0.0:<port>
```

For the sandbox/arena preview, add the preview host to `BRIDGE_ALLOWED_HOSTS`, e.g.
`BRIDGE_ALLOWED_HOSTS="*.e2b.app"` — anything unlisted gets `403 HOST_DENIED`.

## Deferred (gate review `docs/development/phase-7-gate-review.md`)

Tauri shell + React port, OS tray/notifications, file-tree diff viewer, MCP marketplace UI.
