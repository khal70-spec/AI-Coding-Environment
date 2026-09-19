# Phase 10 gate review — production-depth increment (2026-09-19)

**Verdict: DONE for the offline-executable lanes; native-shell lanes proven blocked
with evidence in this sandbox.** Test count: 580 → **605** (all green). Security gate
GREEN (164 files). a11y gate GREEN. This increment executes the ordered path-to-100
from `docs/release/project-state.md` — every lane that is real offline materialized;
every lane that is not was probed and recorded, not papered over.

## Landed

| Lane (path-to-100 #) | Deliverable | Evidence |
|---|---|---|
| #4 detector depth | **Unicode canonicalization lane** in `packages/security/src/injection.ts`: NFKC fold → invisible/bidi control strip (escaped codepoints only — two literal-in-source attempts were caught by tests and purged) → bounded Cyrillic/Greek confusables map. Monotonic: canonical hits are strictly additional to raw hits; `unicode-obfuscation` hygiene class finding accompanies canonical-only matches. | `tests/security/redteam-injection-v2.test.mjs` 8/8 (full-width payload, Cyrillic homoglyphs, ZWSP-split, RLO/PDF Trojan-source markers, math-bold alphabet, monotonicity + emoji-purity). All 141 security suites green. |
| #3 provider conformance | **Conformance harness** `tests/integration/provider-conformance.test.mjs`: real loopback HTTP mocks + real `fetchTransport` sockets per protocol (openai-chat, anthropic-messages, nvidia-nim, generic-rest): request shape, auth-header placement (Bearer / x-api-key), anthropic system-lifting + `max_tokens` default, finish/stop tables, usage mapping, content-parts concat, error mapping (401/429+retry-after→9s/413/500), tool-role fail-closed VALIDATION, missing-config-path no-silent-fallback, egress policy (http remote denied / loopback accepted / https vendors accepted). | 10/10 green in 492ms. Found two honest test discoveries (record `displayName` shape; generic bearer default requiring creds BEFORE content-path validation) — fixed tests, code correct-by-design. |
| #2 supply-chain depth | **CycloneDX 1.5 SBOM lane** `scripts/sbom-generate.mjs` + `tools:sbom` script: 14 workspace components + 98 locked third-party (integrity SHA-512 carried), workspace-symlink rows correctly excluded, **0 runtime-lane components** (matches supply-chain R1 policy), deterministic byte-identical regeneration. | `tests/integration/sbom.test.mjs` 4/4. |
| #5 operator UX | **Diff viewer lane**: new allowlisted bridge command `tasks.diff` (project-scoped, base→working-tree, argv-only `git diff <baseSha>` via GitRunner; redacted, 30k-capped; content-free audit) + SPA surface (stat + collapsible patch). | `tests/unit/ui/bridge.test.mjs` diff-lane describe (3 lanes incl. cross-project scoping refusal) 13/13 total; frozen-surface pin updated (`tasks.diff` now documented id). a11y GREEN. |

## Proven blocked in this sandbox (evidence, not deferral-by-preference)

| Lane (path-to-100 #) | Probe evidence | Where it lands |
|---|---|---|
| #1 Tauri 2.x native shell | `which rustc cargo rustup` → absent; `pkg-config webkit2gtk-4.1` → not present; `curl -sI https://sh.rustup.rs` → unreachable (no output). apt present but toolchain+gui stack beyond sandbox lane. | Remains the packaged-product tail. Bridge kernel carries forward unchanged — the diff lane just landed ON it, proving continuity again. |
| #1 React port of desktop UI | Introducing react/react-dom/vite runtime+build deps would **violate our own R1 zero-runtime-deps supply-chain rule** and the offline OSV lane is unavailable; the vanilla ES-module SPA remains the deliberate dependency-free form; the diff viewer shipped inside that constraint today. | Port decision deferred to the packaged-product track where OSV/Semgrep CI lanes exist (dependency-policy v2). New deliverables therefore stay zero-dep. |
| #2 code-signing + auto-update | No packaged binary exists to sign (shell-gated); signing config scaffolding without a target would be placebo. | native-shell tail. |
| #4 model-backed multilingual detector | No model serving offline; regex+canonicalization lane is what is real here. | threat-model residual, explicitly bounded. |
| #5 tray/notifications/shortcuts, AT review | native-shell-gated. | native-shell tail. |

## Verification (fresh, verbatim)

- `npm test` → `# tests 605 / # pass 605 / # fail 0`
- `npm run lint` exit 0 · `tsc --noEmit` exit 0
- `SECURITY GATE: GREEN` (4/4 lanes, 164 SAST files)
- `A11Y-CHECK: GREEN (0 notes)`
- `SBOM: 112 components (14 workspace, 98 locked, 0 runtime-lane)`
- release-prepare/verify + release-check R1–R10: rerun at close-out commit (see tag).

## Attainment moved

`docs/release/project-state.md` recomputed: **87% → ~90%** (providers 85→92,
agents 90→93, hardening 90→94, ops 90→93, desktop 55→62 on the new diff/surface depth).
See that document for the live model.
