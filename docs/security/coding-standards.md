# Secure Coding Standards (Phase 0 baseline)

## TypeScript

- `strict` mode, ESM, no `any` without a `// SAFETY:` justification comment.
- Validate at boundaries: IPC, tool args, provider responses, MCP payloads, config files.
  Use explicit schemas/guards — never trust shapes.
- No `eval`, `new Function`, or dynamic `import()` of untrusted paths.
- Shell: never interpolate untrusted strings; tools take `argv[]`, and the command
  classifier (`packages/security`) must approve before spawn.
- Paths: canonicalize (`realpath`) then containment-check against workspace root on
  every read/write/delete; decide symlink policy per call (default: do not follow
  escaping symlinks).
- Secrets: handles only; all new I/O goes through redaction; no secret values in
  errors/logs/tests (see `secret-policy.md`).
- Randomness: `node:crypto` (`randomBytes`/`randomUUID`) for tokens/ids/nonces.
- Crypto: AES-256-GCM + per-record nonces for the vault fallback; keys from OS store;
  never home-grown ciphers or ECB/CBC-without-HMAC.

## Error handling

- Fail closed: on policy/auth/validation failure, throw a typed error and stop.
- Errors carry `{ code, message, remediation }`; messages never include secrets,
  full paths outside the workspace, or PII.

## Logging & audit

- Structured events; secret/PII redaction at the sink; audit fields from an allowlist.
- `console.log` of request/response bodies is forbidden in provider/tool code.

## Tests

- Every security control ships with a negative test (bypass attempt must fail).
- Fixtures synthetic only, with fake markers (`secret-policy.md`).

## Dependencies

- Prefer `node:` builtins over new packages. New deps need justification + audit;
  see `dependency-policy.md`.
