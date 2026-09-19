# Phase 7 gate review — Desktop UI (ADR-001 divergence: bridge-kernel POC)

**Verdict: PASS (POC lane), with an explicit, tracked divergence from ADR-001.**

## What shipped

| Item | Backlog | Reality |
|---|---|---|
| `packages/ui/src/bridge.ts` | P7.1 | `BridgeRegistry` — allowlisted commands, strict per-command arg schemas (type/required/max/pattern/enum), prototype-chain smuggle rejection, frozen reply lanes `{ok,data} \| {ok:false,code:{UNKNOWN_COMMAND,BAD_ARGS,HANDLER_FAILED,NOT_FOUND}}`, `BRIDGE_VERSION="1"`, `bridgeFingerprint` (sha256-16, order-insensitive). |
| `packages/ui/src/commands.ts` | P7.1 | 15 commands over storage DAOs + `TaskEngine`. Mutations go through the engine (invariants can never be bypassed); denials surface as `HANDLER_FAILED` with `ENGINE_*` codes; task rows never touched on denial (db-asserted). |
| `apps/desktop/src/server.ts` | P7.2 | Node HTTP adapter: host allowlist, POST-only API, 64KB body cap (413 **delivered** with `connection: close`, never a silent socket kill), control-byte reject, bounded replies, traversal-proof static whitelist, CSP `default-src 'self'`, `nosniff`, `X-Frame-Options: DENY`, `no-store` API, zero CORS (same-origin by construction). |
| `apps/desktop/web/` | P7.3 | Dependency-free ES-module SPA (§4.2 IA subset): Projects / Tasks / Agent sessions / MCP / Skills / Audit. All dynamic content via `textContent` — no `innerHTML`, so untrusted transcripts render as inert text. |
| `tests/unit/ui/bridge.test.mjs` | P7.4 | Kernel fuzz matrix (13 hostile arg shapes incl. `__proto__` smuggle — **found a real bug**), live-service CRUD/engine/audit proofs, cross-scope refusal (T20), transcript redaction+bounding, command-surface freeze (exact id set). |
| `tests/unit/desktop/server.test.mjs` | P7.4 | Request canopy: host gate (403), POST-only (405), JSON-only (400), body cap (413), static whitelist + traversal (400/404), HEAD variant, MIME whitelist, unknown-command lane, live engine dispatch, hostile-envelope fuzz (no crashes, bounded replies). |
| `tests/unit/desktop/e2e.test.mjs` | P7.5 | Operator workflow over the LIVE server: project → task → governed walk. Governance brakes proven: PLANNING→PREPARING requires plan approval (`ENGINE_APPROVAL_REQUIRED`, state unchanged, deny audited); IMPLEMENTING requires checkpoint (`ENGINE_CHECKPOINT_REQUIRED`); evidence self-attestation commands (`verify`, `checkpoint`, `review`, `engine.override`, `sql`) are `UNKNOWN_COMMAND`; BLOCKED sticks; audit monotonic append-only; multi-project isolation. |

## Threat model exercised (Plan §28)

| Threat | Defense (mechanism, not policy) | Proof |
|---|---|---|
| Renderer/code-injection reaches internals | Command allowlist + arg pinning; no `eval`-shaped bridge; dispatcher never throws | `bridge.test.mjs` fuzz matrix |
| Prototype pollution via args | `__proto__`/`constructor`/`prototype` keys rejected; `Object.hasOwn` checks; null-prototype output object | `proto key smuggle` test |
| Evidence self-attestation from UI | Evidence commands **do not exist in the allowlist**; engine re-validates on transition | e2e brakes #1/#2 + ghost-command test |
| XSS from model transcripts/MCP config | `redact()` + length bounds at the DAO boundary; SPA renders `textContent`-only | redaction test + grep-verified no `innerHTML` |
| Request desync / oversized body | cap → 413 + `connection: close` (data drained, response delivered) | server test 413 lane |
| Path traversal on static | regex whitelist + deny `..` + prefix clamp under web root | traversal battery (`/../`, `%2e%2e`, `..\\`) |
| Clickjacking / content-type confusion | `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `nosniff`, MIME whitelist | header asserts |
| Host-driven cache/preview confusion | host allowlist (403 `HOST_DENIED`); preview hosts opt-in via `BRIDGE_ALLOWED_HOSTS` | host-gate test (incl. subdomain) |
| Unaudited mutation | every mutation funnels through engine/DAO audit lanes; cross-scope reads `NOT_FOUND` | e2e audit asserts |

## ADR-001 divergence (recorded, bounded)

ADR-001 selects **Tauri 2.x + React** for the packaged desktop product, with the note
"all application logic must live in `packages/` behind tested kernels first". That kernel
condition is now fully satisfied: **the entire Phase 7 security surface lives in
`packages/ui`** (bridge registry + commands) with the protocol pinned by
`BRIDGE_VERSION` + `bridgeFingerprint` and proven by kernel tests. The React/Tauri shell
will reuse `BridgeRegistry` unchanged — only the two thin adapters (tauri IPC endpoint in
place of `apps/desktop/src/server.ts`, React components in place of
`apps/desktop/web/app.js`) migrate. Decision to land POC first: (a) sandbox has no Rust
toolchain, (b) shipping the hardened bridge protocol + tests de-risks the shell swap, (c)
zero new runtime dependencies in a governed environment (supply-chain posture).

## Explicit deferrals

1. **Tauri 2.x shell + React port** (ADR-001 final form) — bridge kernel reused as-is.
2. **File-tree diff viewer / merge UX** — needs git worktree diff lane through the bridge (read-only, path-scoped); follow-on ticket.
3. **MCP marketplace / skill authoring UI** — review surfaces exist (list/toggle/log); consent flows stay on `aice mcp/skill` CLI lanes (tamper-check path is CLI-only by design).
4. **OS tray/notifications/shortcuts** — belong to the native shell.
5. **SPA unit tests for DOM rendering** — rendering invariants asserted structurally (no-`innerHTML` grep + integration over fetch); a DOM-level test runner (e.g. happy-dom) is deferred with the React port.

## Gate evidence (verbatim)

- `npm test` → `# tests 517 / # pass 517 / # fail 0`
- `npm run lint` → exit 0 (includes the new browser-globals block for `apps/*/web`)
- `tsc --noEmit -p tsconfig.base.json` → exit 0
- Live server smoke: 200 static + 200 API happy path, 404 unknown command, 400 traversal, 403 foreign host, 413 oversized (verified against the arena preview process).
