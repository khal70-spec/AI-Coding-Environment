# ADR-006: Secret storage — OS keychain + encrypted vault fallback

- **Status:** accepted
- **Date:** 2026-09-17
- **Plan refs:** §11, §26, §27, §30
- **Threats:** T5, T11

## Context

Provider API keys and MCP credentials need at-rest protection on Windows/macOS/Linux with a
portable fallback, plus retrieval semantics that keep values out of prompts/logs/state.

## Decision

- **Primary**: OS credential store per platform (Windows Credential Manager/DPAPI, macOS
  Keychain, Linux Secret Service/libsecret) via small platform adapters.
- **Fallback**: application encrypted vault — AES-256-GCM, per-record nonce, key derived
  from an OS-bound secret (DPAPI/Keychain-protected bootstrap) — used only when no OS
  store is available, with a visible security notice.
- **Interface** (`packages/secrets`): handles only.

```ts
interface SecretVault {
  store(ref: SecretRef, value: SecretValue): Promise<void>;
  load(ref: SecretRef): Promise<SecretValue>;   // narrow call sites only
  rotate(ref: SecretRef, value: SecretValue): Promise<void>;
  delete(ref: SecretRef): Promise<void>;
  describe(ref: SecretRef): Promise<SecretMeta>; // last4 + timestamps, never value
}
```

SQLite holds `provider_credentials` **references** (`vault://…`), never values.
`SecretValue` is a branded type; a `redact()` pass covers all logging/audit/UI paths.

## Consequences

- Phase 0–1: interface + in-memory/file test double + redaction + patterns.
- Phase 2: OS adapters + encrypted fallback + connection-test flow (value used once for
  HTTPS, never persisted in clear).
- Audit events record rotation/revocation, never values.

## Alternatives considered

- **Env vars / config files**: rejected — leak into logs, shells, snapshots.
- **Third-party cloud KMS**: rejected for local-first v1 — external dependency + data egress.

## Security considerations

Stolen-key (T5) blast radius reduced to endpoint compromise; exfil (T11) blocked by
handle-only flow + redaction tests (`tests/security/secret-*.test.mjs`).
