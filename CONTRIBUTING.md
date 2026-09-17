# Contributing

## Ground rules

1. Read `README.md`, `CLAUDE.md`, `AGENTS.md`, and `SECURITY.md` first.
2. Every change maps to the master plan (`AI_Coding_Environment_End_to_End_Plan.md`)
   and to a backlog item in `docs/backlog/`. No silent scope cuts to security controls.
3. Build order is mandatory (Plan §54): security/runtime layers before UI.
4. Architectural or security-relevant changes need an ADR (`docs/adr/`).

## Workflow

```bash
git checkout -b <short-task-branch>        # never commit straight to main
npm install
# implement + add tests
npm test
npm run check:secrets
npm run audit:deps
```

- Keep diffs minimal and typed (`strict` TypeScript, ESM, no `any` without comment).
- Put unit tests in `tests/unit/<package>/`, security tests in `tests/security/`.
- Use **synthetic fixtures only** — no real keys, tokens, or user data.
- Update docs/backlog checkboxes and any affected `docs/` page in the same PR.

## Commit messages

```text
<area>: <imperative summary> (Plan §XX)

Optional body: what/why, risk level, evidence, rollback.
```

Areas: `policy`, `secrets`, `storage`, `git`, `providers`, `orchestrator`, `agents`,
`tools`, `security`, `context`, `mcp`, `docs`, `ci`, `cli`, `desktop`, `skills`.

## Pull requests

- [ ] Linked backlog item + Plan section
- [ ] Risk level stated (low/medium/high); high-risk has impact + rollback plan
- [ ] Tests added/updated; evidence pasted
- [ ] `npm run check:secrets` passes; no secrets in diff
- [ ] `npm audit --audit-level=high` clean (or exception documented)
- [ ] ADR added/updated if architectural
- [ ] Docs updated; no TODOs left that weaken security

## Release discipline (later phases)

`source → test → security → signed build → artifact verification → release`.
Never execute unsigned updates; verify publisher, signature, checksum, version.
