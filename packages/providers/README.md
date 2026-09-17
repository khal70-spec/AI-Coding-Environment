# `@ai-coding-env/providers`

Provider framework (Plan §10–13, ADR-002). A model is configuration, not architecture.

**Layers:**
- `src/index.ts` — interface + normalized `ModelRecord` + in-memory registry + validation.
- `src/errors.ts` — stable error taxonomy (`AUTH/RATE_LIMIT/CONTEXT_LENGTH/SERVER/NETWORK/VALIDATION/SECRET_IN_REQUEST/EGRESS_DENIED/PROTOCOL_UNSUPPORTED/CLASSIFICATION_DENIED`); transient vs terminal for failover.
- `src/http.ts` — the only network path: egress-checked transport (https-remote /
  loopback-local only, `redirect: "error"`, timeout, byte cap, secret-redacted errors).
- `src/base.ts` — `BaseAdapter`: key resolution at header-build time only, never logged/stored.
- `src/adapters.ts` — `openai-chat`, `anthropic-messages`, `nvidia-nim`,
  `generic-rest`, `local-openai-compatible` + `createAdapter` factory.
- `src/dispatcher.ts` — every completion passes: classification gate (Plan §36) →
  egress gate → outbound secret gate → adapter; content-free events to the audit sink.
- `src/registry.ts` — discovery → DB merge (status/verification preserved), text
  capability probes (`available` only on round-trip pass), `DbModelRegistry`.
- `src/router.ts` — `FailoverRouter`: ordered candidates, classification-filtered,
  transient → next hop (marks degraded), AUTH → marks unavailable, request-scoped
  failures stop the chain, health cache with TTL; every hop audited.

**Security posture:** providers are operator-configured but marked untrusted
(Plan §36). Provider credentials never touch HTTP logs, error text, DB, or argv;
outbound messages containing secret-shaped text stop cold (`SECRET_IN_REQUEST`).

Tests: `tests/unit/providers/` (transport, adapter contract, dispatcher gates,
registry/probes, failover matrix).
Vault integrations live in `@ai-coding-env/secrets`. Budgets + CLI land in P2.7–P2.8
(`docs/backlog/phase-2-provider-framework.md`).
