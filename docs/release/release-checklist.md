# Release checklist — v0.6.x (Plan §50/51, §53)

Every row is machine-checked by `node scripts/release-check.mjs`. Sign-off requires
ALL rows PASS plus the human attestations at the bottom.

| Row | Gate | Lane |
|---|---|---|
| R1 | `npm test` | unit + integration + security suites green |
| R2 | `npm run typecheck` (tsc --noEmit) | exact types across the repo |
| R3 | `npm run lint` (eslint) | all shipped lanes clean |
| R4 | `npm run security:gate` | secrets / dep-audit / supply-chain / SAST-lite |
| R5 | `node scripts/migration-check.mjs` | additive-only, well-formed migration set |
| R6 | `node scripts/a11y-check.mjs` | desktop web static a11y rules (A1–A9) |
| R7 | gate reviews phase-0…9 present | `docs/development/phase-N-gate-review.md` × 10 |
| R8 | runbooks + release docs present | `docs/runbooks/*`, `docs/release/*` |
| R9 | no TODO/FIXME/XXX/HACK in shipped lanes | `git grep` over packages/apps/scripts |
| R10 | `node scripts/release-verify.mjs` | artifact sums + byte-identical rebuild proof |

## Human attestations (cannot be mechanized)

- [ ] Operator ran the §53 golden workflow manually once on this build
  (scripted equivalent: `tests/integration/release-workflow.test.mjs`) — initials: ___
- [ ] `docs/security/threat-model.md` v2.0 residual-risk log reviewed and accepted —
  initials: ___
- [ ] ADR set (001–010) read against the shipped code — initials: ___

## Tag

```
git tag -a v0.6.0-phase9 -m "Phase 10 release — see release checklist"
node scripts/release-prepare.mjs
node scripts/release-verify.mjs
```
