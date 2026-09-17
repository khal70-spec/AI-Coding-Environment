# Architecture Decision Records

Decisions are frozen rationale: status `accepted` means the project builds on it until a
superseding ADR lands. Proposing a change = new ADR + threat-model/policy review, never a
silent edit (Plan §57).

## Index

| ADR | Title | Status |
|---|---|---|
| [000](./ADR-000-template.md) | Template | — |
| [001](./ADR-001-desktop-shell-tauri.md) | Desktop shell: Tauri 2.x first | accepted |
| [002](./ADR-002-provider-interface.md) | Provider adapter interface | accepted |
| [003](./ADR-003-agent-permissions.md) | Agent permission manifests | accepted |
| [004](./ADR-004-workspace-isolation.md) | Workspace isolation via Git worktrees | accepted |
| [005](./ADR-005-mcp-security.md) | MCP manager security model | accepted |
| [006](./ADR-006-secret-storage.md) | Secret storage: OS keychain + vault fallback | accepted |
| [007](./ADR-007-task-state-machine.md) | Task state machine | accepted |
| [008](./ADR-008-storage-sqlite.md) | Local storage: SQLite + migrations | accepted |
| [009](./ADR-009-sqlite-driver-node-sqlite.md) | SQLite driver: `node:sqlite` (Phase 1) | accepted |

## Format

Each ADR: context → decision → consequences → alternatives → security considerations →
links (Plan sections, threat-model threats, packages).
