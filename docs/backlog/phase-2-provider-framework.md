# Phase 2 — Provider framework (Plan §54.9–11, cores §10–13)

**Goal**: models become live but untrusted I/O. Every provider call is egress-checked,
secret-gated on send, redacted on log/audit, classification-gated on context,
and budget-limited. No streaming in Phase 2 (attach points only).

**Entry state**: approved Phase 1 (`717256e`, tag `phase-1-complete`);
provider/model/credential tables exist; vault is handle-only with test double.

## P2.1 Provider runtime core

- [x] Repo hygiene: migration `002_provider_config.sql` (`providers.config_json`)
- [x] Storage DAOs: `ProvidersDao`, `ProviderCredentialsDao` (vault refs only),
  `ModelsDao` — parameterized, no secret values
- [x] `ProviderError` taxonomy (`AUTH | RATE_LIMIT | CONTEXT_LENGTH | SERVER | NETWORK | VALIDATION | SECRET_IN_REQUEST | EGRESS_DENIED`)
- [x] `http.ts`: fetch transport — egress-allowlist per provider (https-only remote;
  loopback http carve-out **only** for `local-openai-compatible`), `redirect: "error"`,
  timeout, response byte cap, redacted error detail, `GIT_TERMINAL_PROMPT`-style
  non-interactive discipline

## P2.2 Adapters (translators only — policy stays in core)

- [x] `OpenAIChatAdapter` (`openai-chat`: `/v1/models`, `/v1/chat/completions`)
- [x] `AnthropicAdapter` (`anthropic-messages`: `/v1/models` + `/v1/messages`, `x-api-key` + `anthropic-version`)
- [x] `NvidiaNimAdapter` (openai-compatible, `https://integrate.api.nvidia.com/v1`)
- [x] `LocalOpenAICompatibleAdapter` (loopback-only, keyless-allowed)
- [x] `GenericRestAdapter` (operator-pinned endpoint + key-header + response path)
- [ ] `openai-responses` + `gemini` protocols — deferred (surface exists; no demand yet)

## P2.3 Dispatcher gates (every completion passes through)

- [x] Egress policy check before any send
- [x] Classification gate: `classificationAllowed(contextClassification, provider.maxClassification)`
- [x] Outgoing secret gate: `containsSecret(messages)` → `SECRET_IN_REQUEST` (fail closed; pattern ids in error/audit, never values)
- [x] Key resolution at the narrow call site via `SecretVault` handle (never stored, never logged)

## P2.4 Vault adapters + encrypted fallback (ADR-006)

- [ ] `LinuxSecretToolVault` (`secret-tool`, argv-only) + availability probe
- [ ] `DarwinSecurityVault` (`security add/find-generic-password`, argv-only)
- [ ] `EncryptedFileVault` fallback (AES-256-GCM, 0600 master key, ref validation)
- [ ] `detectVault()` chain + CLI `aice provider key set --stdin` (never argv/flag secrets)

## P2.5 Model registry — discovery + capability verification

- [ ] `discoverModels(provider)` → diff/merge into `models` table (`unverified` until probed)
- [ ] Capability probes (text round-trip; tools/structured-output later); mark `available` only on pass
- [ ] DB-backed registry adapter replacing `InMemoryRegistry` for CLI/orchestrator reads

## P2.6 Connection testing, health, failover

- [x] `testConnection(provider)`: health + auth + list probe, structured report (no stack/body leaks)
- [ ] Health cache with TTL + status transitions (`available/degraded/unavailable`)
- [ ] `FailoverRouter`: ordered candidates, classification-filtered; transient
  (RATE_LIMIT/SERVER/NETWORK) → next; AUTH/VALIDATION → mark unavailable, stop; audit every hop

## P2.7 Budgets

- [ ] Migration `003_budgets.sql` (`budgets`, `budget_events`)
- [ ] `BudgetDao` + pre-dispatch spend check (fail closed) + usage recording from `ChatResponse.usage`
- [ ] CLI `aice budget set/list/events`

## P2.8 CLI, tests, close-out

- [ ] `aice provider add/list/remove/test`, `aice model list/probe`
- [ ] Tests: adapter contract (loopback mock, canned OpenAI/Anthropic shapes),
  redaction on I/O, egress denial matrix, failover matrix, vault fallback roundtrip +
  wrong-key fail-closed, budget block
- [ ] ADR-010 (fetch transport + redirect policy) if needed; docs sweep; gate review; tag

**Done = tests + secret scan + audit + typecheck green; provider I/O provably
redacted/egress-gated/classification-gated; no secret value ever in DB/logs/argv.**
