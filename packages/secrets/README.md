# `@ai-coding-env/secrets`

OS keychain handles + encrypted fallback (Plan §11, ADR-006, threat T5).

**Discipline (enforced by construction):**
- `SecretRef`/`SecretValue` are branded; values cross the membrane in
  `store()`/`load()` only — never logged, persisted, argv'd, or embedded in prompts.
- DB rows store `vault://` refs only (`ProviderCredentialsDao` rejects anything else).

**Backends (`detectVault()` picks):**
1. `LinuxSecretToolVault` — libsecret `secret-tool`, stdin-only values, argv-free (T5).
2. `EncryptedFileVault` — always-available fallback: AES-256-GCM per entry with the
   ref as AAD (no ref-swapping), 0600 master key, loose-permission detection, atomic
   writes, wrong-key/corruption fail-closed (`BACKEND_UNAVAILABLE`).
3. `DarwinSecurityVault` — read-capable; `store()` fails closed with remediation
   because `security add-generic-password -w <value>` puts the secret in argv.

`MemoryVault` is the TEST DOUBLE ONLY. Master spec: `AI_Coding_Environment_End_to_End_Plan.md`.
Tests: `tests/unit/secrets/` (round-trips, wrong-key, loose perms, argv-safety, detection).
