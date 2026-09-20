# `@ai-coding-env/memory` — agent memory (Plan §25)

Scope-isolated memory store for the environment. Separate lanes (§25):

| Scope | Holds | Default retention |
|---|---|---|
| `global` | user/tool preferences (never project data) | forever, 1000 entries |
| `project` | durable project knowledge | forever, 500/project |
| `task` | task history + decisions | 90 days, 500/task |
| `model` | observations about a model | 180 days, 500 |
| `scratchpad` | short-lived working notes (task-pinned) | 7 days, 200 |

## Guarantees (machine-enforced)

- **No cross-project leakage (T20)** — every row is a total key
  `(scope, project_id, task_id, model_id, key)` and every read is scope+id-exact;
  there is no cross-partition query at all (migration 006 + `MemoryService`).
- **Secrets never stored** — writes run the secret detector and fail closed
  (`SECRET_REFUSED`); export re-runs redaction anyway (belt + braces).
- **Visibility / deletion / export / retention** (§25's four requirements) are
  first-class: `list/get`, `delete/purge`, `export` (contained, redacted),
  `retention` + `sweep` (TTL, age-cutoff, per-scope budget trim).
- **Every mutation is audited** content-free (`memory.set/.delete/.purge/.export/
  .sweep/.retention`) — key/scope/row-counts only, never values.

The policy gate sits at the tool layer: `memory.read` / `memory.write` are
registered tools (`packages/tools/src/memory-tools.ts`) granted only where the
agent manifest says so (today: `orchestrator` only — see `packages/agents`).
CLI operator lanes: `aice memory …` (every mutation lands in the audit trail).

Master spec: `AI_Coding_Environment_End_to_End_Plan.md` §25. ADR-003 (permissions),
ADR-008/009 (storage). Tests: `tests/unit/memory/`, `tests/unit/tools/memory-tools.test.mjs`.
