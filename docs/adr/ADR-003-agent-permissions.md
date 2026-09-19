# ADR-003: Agent permission manifests (machine-enforced)

- **Status:** accepted
- **Date:** 2026-09-17
- **Plan refs:** §3.4, §7, §8, §18
- **Threats:** T13, T14, T8, T9, T18

## Context

Agents must be least-privilege workers. Policy must be data (declarative manifests) enforced
by the policy engine — not prose the model can argue with.

## Decision

Every agent runs under a versioned **permission manifest**:

```yaml
agent: implementer
version: 1
filesystem: { read: project, write: workspace }
terminal:   { execute: approved_commands }
git:        { read: true, write: workspace }
network:    { default: deny, allow: [] }
tools:      { allow: [fs.read, fs.write, search, git.diff, tests.run], deny: [shell.raw] }
maxRisk: medium            # high-risk actions always need human approval
```

> **Clarification (2026-09-17):** the YAML above illustrates the manifest *shape*; the
> canonical tool identifiers are `KNOWN_TOOLS` in `packages/agents/src/index.ts`
> (e.g. `search.exact`, `git.read`, `terminal.run`). Unknown tools are denied by the
> policy engine and rejected by `validateManifest`.

The policy engine evaluates **every** tool call against: manifest + task risk level +
workspace policy + global policy → `allow | approval | deny`. Agents cannot modify their
own manifest; changes are audited user/admin actions.

## Consequences

- `packages/agents`: manifest schema + built-in manifests (investigator read-only default).
- `packages/policy`: pure evaluation kernel with unit tests for allow/approval/deny matrix.
- Reviewer agents get inspect-but-not-weaken rights (cannot edit policy/manifests).

## Alternatives considered

- **Role prose in system prompts**: rejected — advisory, bypassable, unauditable.
- **OS-user-per-agent sandboxing only**: deferred to Level 2/3 sandboxing; manifests are the
  portable enforcement layer that works before/without OS sandboxes.

## Security considerations

Confused-deputy (T13) contained by arg validation + cwd/env pinning; escalation (T14) blocked
by no-self-modify + audit. Negative tests: `tests/security/permission-bypass.test.mjs`.
