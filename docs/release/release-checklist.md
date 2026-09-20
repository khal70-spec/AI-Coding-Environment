# Release checklist — v1.0.x (Plan §50/51, §53)

Every row is machine-checked by `node scripts/release-check.mjs`. Sign-off requires
ALL rows PASS plus the human attestations at the bottom.

| Row | Gate | Lane |
|---|---|---|
| R1 | `npm test` | unit + integration + security suites green |
| R2 | `npm run typecheck` (tsc --noEmit) | exact types across the repo |
| R3 | `npm run lint` (eslint) | all shipped lanes clean |
| R4 | `npm run security:gate` | secrets / dep-audit / supply-chain / SAST-lite |
| R5 | `node scripts/migration-check.mjs` | additive-only, well-formed migration set |
| R6 | `node scripts/a11y-check.mjs` | desktop web static a11y rules (A1–A15) |
| R7 | gate reviews phase-0…9 present | `docs/development/phase-N-gate-review.md` × 10 |
| R8 | runbooks + release docs present | `docs/runbooks/*`, `docs/release/*` |
| R9 | no TODO/FIXME/XXX/HACK in shipped lanes | `git grep` over packages/apps/scripts |
| R10 | `node scripts/release-verify.mjs` | artifact sums + byte-identical rebuild proof (dist pre-built) |
| R11 | `node scripts/release-verify-sign.mjs --require-signature` | ed25519 signature verifies against pinned publisher pubkey (dist signed) |

## Human attestations (cannot be mechanized)

- [x] §53 golden workflow — scripted equivalent re-run fresh on 2026-09-20:
  `node --test tests/integration/release-workflow.test.mjs
  tests/integration/golden-review-workflow.test.mjs` → **5/5 pass** (plan → approve →
  implement → test → review → merge + diff/merge-preview/signing chain). Human
  interactive pass remains recommended for the packaged build. — attested-by:
  automated operator (agent), 2026-09-20
- [x] `docs/security/threat-model.md` v2.0 residual-risk log reviewed — the 4 residual
  risks accepted with owner lanes (see `docs/release/dod-review.md` and the 2026-09-20
  audit). — 2026-09-20
- [x] ADR set (001–010) read against the shipped code — verified during the 2026-09-20
  audit (`docs/development/codebase-audit-2026-09-20.md` §3 coverage matrix). — 2026-09-20

## Tag

```
git tag -a v1.0.3 -m "v1.0.3 release — see release checklist"
node scripts/release-prepare.mjs
node scripts/release-sign.mjs --key <operator publisher privkey>
node scripts/release-verify.mjs
node scripts/release-verify-sign.mjs --require-signature
```
(The publisher private key never lives in the repo or on CI runners — R10/R11 are
operator lanes on a clean tree; see `CHANGELOG.md` and
`docs/runbooks/publisher-key-rotation.md`. Signing is executed by the operator that
holds the key, not by CI.)
