# Native shell execution plan — the one remaining master-plan trunk

Status: BLOCKED in the delegate sandbox (measurable via `node scripts/native-shell-preflight.mjs
--require-ready`; today's report: 5/5 checks blocked — no rust toolchain, no pkg-config,
no webkit2gtk, rustup host unreachable, uid 1001 without root). This plan turns the trunk
into an ordered, verifiable build. Prerequisite source already shipped: the bridge kernel
(`packages/ui`), hardened adapter shape (`apps/desktop`), governance invariants below.

## Invariants any shell must carry unchanged (contract)

1. **All mutations travel the TaskEngine** (`packages/orchestrator`). The UI never writes state directly.
2. **Allowlisted commands only** — `apps/desktop/src/server.ts` is the reference dispatch of
   `buildBridge()`; the Tauri command surface must enumerate the same `registry.ids()` and reject
   everything else. `tests/unit/ui/bridge.test.mjs` frozen-surface test is the contract pin.
3. **argv-only process execution** — git via `GitRunner`, terminal via the capped/redacted runner.
   No `shell: true` anywhere (SAST rule S2 blocks regressions).
4. **Renderer attack surface zero-trust**: CSP from `apps/desktop/src/server.ts` headers, no
   remote content, traversal-proof static serving, byte caps, request timeouts.
5. **Display-only lanes stay display-only**: transcripts/diffs are redacted + truncated at the
   bridge; the renderer presents, never interprets.
6. **Fail closed**: every refusal path is an exit-code/message pair, never a silent no-op.

## Build sequence (executable on any dev machine with root)

1. `node scripts/native-shell-preflight.mjs --require-ready` — must print READY. On a real host:
   rustup toolchain (`stable`, ≥1.85 for the 2024 edition), `libwebkit2gtk-4.1-dev`,
   `libsoup-3.0-dev`, `libgtk-3-dev`, `pkg-config`, `curl`, `build-essential` (Linux) /
   Xcode CLT (macOS).
2. Scaffold `apps/desktop/src-tauri/` (Tauri 2.x):
   - `tauri.conf.json`: `build.frontendDist = "../web"`, `app.withGlobalTauri = false` (no
     untrusted globals), CSP identical to today's hardened headers, single window 1280×900,
     `tsp: true`, custom protocol for assets only.
   - `main.rs`: registers exactly one invoke handler per bridge command id, delegating to a
     Rust driver `bridge_invoke(cmd, args_json) -> BridgeReply`. The handler list is generated
     FROM `registry.ids()` — a generator script reads the JS registry and emits the Rust match,
     keeping the frozen surface identical by construction.
   - Bridge execution model: spawn the existing Node bridge adapter as a sidecar
     (`node apps/desktop/src/server.ts --tauri-sidecar`) bound to `127.0.0.1:0` with an
     ephemeral token in the `AICE_SIDECAR_TOKEN` env; Rust forwards invokes over HTTP with the
     token. Zero kernel changes — continuity proven by the merge-preview/diff lanes that already
     sit on this kernel. (Target v1.2 when the Rust port lands: single-process.)
3. Port the SPA: same six surfaces + diff/merge-preview panels, React + TypeScript, build to
   `apps/desktop/web-react/dist`, wire `frontendDist`. The shipped vanilla web bundle stays as the
   no-build fallback (zero runtime deps — R1 keeps passing).
4. Signing/update:
   - macOS: Developer ID + notarization; Windows: Authenticode (OSS cert via Azure Trusted
     Signing or certum); Linux: AppImage + GPG of AppImage.
   - Tauri updater endpoints per channel (latest/canary), keys via env (never committed);
     publisher private key rotation follows `docs/runbooks/publisher-key-rotation.md`.
5. Conformance re-run before any tag `v1.1.0`:
   - `npm test` (614+), `npm run security:gate` (5 lanes), `node scripts/a11y-check.mjs`
     (A1–A15 against BOTH web and web-react outputs), `node scripts/release-check.mjs` (11/11,
     R11 signed by the NEW platform signer as well as the existing ed25519 chain).
   - `tests/integration/provider-conformance.test.mjs` loopback confirmation + live-vendor
     credentialled lanes in CI (secrets via GitHub OIDC, never long-lived).
   - AT pass: VoiceOver (macOS) + NVDA (Windows) against the gating checklist in the a11y script
     comments (motion, headings, focus order, aria-current, labels, contrast — the exact static
     rules A10–A15 become the manual checklist base).
6. Remote-MCP OAuth profile + marketplace UI: only after 2–4 ship; remote profile remains
   fail-closed until the OAuth lane is implemented incl. token storage in the OS keychain lane of
   the secrets service.
7. Model-backed multilingual detector: standalone service or in-proc WASM lane; must keep the
   existing offline canonicalization layer as the deterministic fallback (never degrade to
   model-unavailable ⇒ silent).
8. Versioning: `v1.1.0` = packaged shell + React port + signing + updater; `v1.2.0` =
   single-process Rust kernel port (long-tail, bridge preserved as the contract).

## Verification gate for this trunk

`docs/release/project-state.md` recomputation rule: the desktop-product domain moves 68% → 90%+
only when items 1–4 are complete with the §5 evidence committed. Nothing here is optional-knob
work; it is the reason the bridge kernel was designed environment-agnostic.
