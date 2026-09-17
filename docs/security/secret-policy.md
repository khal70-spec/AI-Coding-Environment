# Secret Policy (Plan §11, ADR-006)

## What counts as a secret

API keys, passwords, tokens (auth/refresh/session), private keys, certificates with keys,
connection strings, CI/CD secrets, webhook signing secrets, PII/credentials in test data.

## Storage

1. OS credential store first: Windows Credential Manager/DPAPI, macOS Keychain,
   Linux Secret Service/libsecret.
2. Application encrypted vault as controlled fallback (AES-256-GCM, OS-bound key).
3. Never plaintext in SQLite, config files, logs, or state snapshots.

See `ADR-006-secret-storage.md` for the vault interface and data model.

## Handling rules

- Retrieve by handle; inject only into outbound provider HTTPS requests.
- Never place secret values in prompts, model context, tool arguments that get logged,
  error messages, or audit content fields (store hashes/redacted summaries).
- Redact on: tool output capture, model input assembly, log writes, UI display
  (show only `…last4` after entry, never full value again).
- Clipboard: clear after timeout; warn on copy of secrets.
- Rotation: support rotate + revoke + delete per provider; audit the event, not the value.

## Fixtures & tests (so `npm run check:secrets` + Gitleaks stay green)

- All test/CI secrets must be **obviously fake** and carry a marker the scanner skips:
  `EXAMPLE`, `TESTONLY`, `<redacted>`, `***`, `your-key-here`, or `xxxx`.
- Example: `api_key = "TESTONLY-not-a-real-key-12345"`.
- Real-shaped patterns (e.g. `sk-…` with 20+ mixed chars, `AKIA…`, PEM blocks,
  `ghp_…`) are **forbidden** anywhere except the allowlisted pattern-definition files:
  `packages/security/src/secret-patterns.ts`, `tests/security/secret-*.test.mjs`,
  `scripts/check-secrets.mjs`, and this policy doc (this sentence contains no live pattern).
- If a real credential ever touches the repo: rotate it immediately, purge history,
  record an incident note.

## Code review checklist for secrets

- [ ] No new secret-shaped literals (scanner evidence)
- [ ] New I/O paths pass through redaction
- [ ] New storage fields reviewed: secret? → vault, not SQLite column
- [ ] Docs show placeholders, never live-looking values
