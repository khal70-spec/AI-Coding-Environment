# Runbook: provider failure (offline lanes)

## Symptoms → lanes
- `aice doctor` reports provider unhealthy → `aice provider list` + adapter-side
  `health` timeouts (HEALTH_TIMEOUT_MS = 10s lanes).
- `ProviderError` codes in audit/tests: NETWORK (transport), AUTH (401/403 lanes),
  RATE_LIMIT (429 + retry-after), CONTEXT_LENGTH (413/oversize body patterns),
  VALIDATION (wire-shape mismatch — no silent fallback, by design),
  EGRESS_DENIED (endpoint policy refused), SECRET_IN_REQUEST (outbound gate).

## Diagnosis ladder
1. `aice doctor` — redacted env+provider summary.
2. Run the socket-level conformance harness for the adapter class:
   `node --test tests/integration/provider-conformance.test.mjs` — a GREEN harness
   with a failing live call = credentials/endpoint issue, not adapter drift.
3. Egress: `assertProviderEndpoint` guards http-remote (denied) vs loopback (dev)
   vs https vendors (allowed). Non-listed vendor origin = denied by policy, add as
   local-openai-compatible if it's truly local.

## Recovery
- Rate-limit: respect retryAfterMs; the dispatcher surfaces it verbatim.
- Bad keys: rotate via `aice provider key set --stdin` (never an argv/log lane).
- Context length: shrink the bundle (`context pack` with a smaller max-tokens),
  or split the task. Do NOT raise provider-side ceilings ad hoc — the guardrails
  (`packages/providers/src/http.ts` byte caps) are policy, not suggestions.

## Escalation evidence
- Audit rows (content-free) + `agent_runs` rounds/denials give a complete,
  redacted incident trail for vendor tickets.
