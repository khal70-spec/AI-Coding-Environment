# `@ai-coding-env/cli` — `aice`

Operator/CI CLI. Phase 0: `version`, `help`, `doctor` only. Requires Node.js ≥ 22.18
(runs TypeScript via flag-free type-stripping). Run with:

```bash
node apps/cli/src/cli.ts doctor
```

`doctor` checks the Node floor and the repo layout (core kernels, storage schema +
migrations) — fully offline.
