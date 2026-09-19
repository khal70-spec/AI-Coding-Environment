# Phase 11 gate review — release hardening + native-shell divergence closure (2026-09-19)

**Verdict: DONE.** Test count: 605 → **611**. Every still-open lane from the phase-10
review was either closed with deterministic code (signing, merge preview, a11y depth)
or re-probed for toolchain reach and recorded with final evidence.
Third recorded sandbox re-clone recovered (fetch + `reset --mixed`; uncommitted lanes
survived; `npm ci --ignore-scripts` restored the bench).

## Landed

| Lane | Deliverable | Evidence |
|---|---|---|
| Signed artifacts (offline executable subset of "code-signing identity") | `scripts/release-sign.mjs` (ed25519 via node:crypto; `--genkey` dev lane writes publisher privkey outside the repo and pins `docs/release/publisher-key.pem` in it) + `scripts/release-verify-sign.mjs` (fail-closed: unparsable, absent-when-required, or signature-mismatch all exit 1). Signing payload = the deterministic `SHA256SUMS.txt`, so the chain is: tarball ↔ sums ↔ ed25519 signature ↔ pinned pubkey. | `tests/integration/release-sign.test.mjs` 3/3: round trip OK; tampered sums → SIGNATURE MISMATCH; wrong publisher key → exit 1; unsigned + `--require-signature` → exit 1. |
| Merge-preview lane (file-tree merge UX, offline) | Git kernel extension `GitRunner.runAllowExit` (argv-only + redaction + classifier discipline kept; multi-exit tools return status instead of throwing) + bridge command `tasks.mergepreview` using `git merge-tree --write-tree <targetRef> <taskBranch>` — synthetic, never touches any worktree/index; project-scoped; conflicted file list parsed verbatim. SPA panel shows `merges cleanly into <ref>` or the exact conflict list. | `tests/unit/ui/bridge.test.mjs` 16/16 (clean → mergeable=true, conflicts → `["f.txt"]`, kernel fail-closed on unacceptable exits, argv-boundary proof that a metachar operand never reaches a shell). |
| a11y static depth A10–A13 | A10 `<html lang>`; A11 exactly-one-h1 + no heading skip across emission order; A12 motion must pair `prefers-reduced-motion`; A13 WCAG AA 4.5:1 computed from palette tokens for the eight text-bearing pairs. | Fixes landed under the new rules: `#top` brand → `<h1 class="brand">`, panel hierarchy h3/h4 → h2/h3, `.flash` reduced-motion pairing, `--muted` raised `#8b949e → #9aa7b4`. `A11Y-CHECK: GREEN` A1–A13 with 0 notes. |
| Runbooks (ergonomics ragged edge) | `docs/runbooks/security-incident.md` (triage ladder, injection quarantine, signature-verify path, containment, post-incident fixture policy) + `docs/runbooks/provider-failure.md` (error-code dictionary, diagnosis ladder: doctor → conformance harness → egress policy, recovery, escalation evidence). | files; R8 row continues to hold docs presence. |

## Native-shell trunk — FINAL environment evidence (third datapoint)

- `id -u` = 1001 (unprivileged), `apt-get update` → permission denied on `/var/lib/apt/lists/partial`.
- `curl -sI https://static.rust-lang.org/…/rustup-init` → **no response** (unreachable).
- `which rustc/cargo/rustup` → absent; `pkg-config` → absent; no webkit2gtk.
- Conclusion: Tauri scaffolding/compile cannot run here and would be placebo code.
  The divergence stays at ADR-001 + bridge-kernel continuity (proven again today by
  merge-preview landing on that kernel). The shipped surfaces reference the trunk by
  owner lane: DoD review + threat-model + this review.

## Verification (fresh, verbatim)

- `npm test` → `# tests 611 / # pass 611 / # fail 0`
- lint 0 · tsc exit 0
- `SECURITY GATE: GREEN` (167 SAST files)
- `A11Y-CHECK: GREEN (0 note(s))` across rules A1–A13
- release-prepare/verify/sign + verify-sign + release-check: run at close-out commit.

## Readiness moved

`docs/release/project-state.md`: **~90% → ~91% (90.8%)** — ops/release 93→96 (signed
artifact chain), desktop 62→68 (merge preview), hardening 94→96 (a11y depth A10–A13).
What remains is recorded as a named trunk, not a fog: native shell + its derived lanes
(signing of binaries, auto-update, tray, OAuth-remote MCP profile, marketplace UI,
React port, human AT pass) + model-backed multilingual detector + live-vendor
credentialled conformance runs.
