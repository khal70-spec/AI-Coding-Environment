# ADR-001: Desktop shell — Tauri 2.x first

- **Status:** accepted
- **Date:** 2026-09-17
- **Plan refs:** §28, §29, §42
- **Threats:** T15, T16

## Context

We need a desktop shell for a security-focused local-first app: small trusted backend,
unprivileged web UI, OS keychain access, signed auto-updates, modest resource use.

## Decision

Evaluate and build on **Tauri 2.x + React + TypeScript** in Phase 7. Electron + TypeScript
is the fallback only if a proven requirement cannot be met, and switching requires a new ADR.

## Consequences

- Rust enters the codebase at Phase 7 for Tauri commands + privileged helpers only,
  behind narrow audited interfaces.
- IPC allowlist + message validation designed with the core now, implemented with the shell.
- Signed updater (Tauri) satisfies Plan §42 publisher/signature/checksum/version checks.

## Alternatives considered

- **Electron**: larger ecosystem, bigger attack surface and resource footprint; accepted only
  as fallback with a full §28 control mapping.
- **Native per-OS UI**: rejected — unsustainable for a small team, no shared UI evidence layer.

## Security considerations

Renderer is untrusted (T15): no Node access, strict IPC allowlist, origin restrictions,
no renderer-provided shell/paths. Abuse coverage: `tests/security/ipc-abuse.test.mjs`
(Phase 7) + IPC fuzz (Phase 8).
