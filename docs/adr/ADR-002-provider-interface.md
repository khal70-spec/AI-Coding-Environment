# ADR-002: Provider adapter interface

- **Status:** accepted
- **Date:** 2026-09-17
- **Plan refs:** §2, §3.2, §3.3, §10–13, §34, §35, §52
- **Threats:** T6, T11

## Context

Providers (OpenAI, Anthropic, NVIDIA NIM, Gemini, local/self-hosted, future) must be
interchangeable. Business logic must never hard-code provider specifics, and models must
be configuration (registry records), not architecture.

## Decision

One internal `Provider` interface in `packages/providers` with protocol adapters:

```ts
interface Provider {
  id: string; name: string; protocol: ProviderProtocol; baseUrl: string;
  auth: AuthSpec;                       // handles only — values from vault at call time
  listModels(): Promise<ModelInfo[]>;   // discovery
  complete(req: ChatRequest): Promise<ChatResponse>; // + stream variant
  health(): Promise<ProviderHealth>;
}
type ProviderProtocol =
  | "openai-chat" | "openai-responses" | "anthropic-messages"
  | "gemini" | "nvidia-nim" | "generic-rest" | "local-openai-compatible";
```

NVIDIA NIM is an adapter over its OpenAI-compatible + Anthropic-compatible endpoints —
no NVIDIA special-casing in core/orchestrator code. New providers ship as adapter +
registry entry + capability tests; orchestrator code never changes to add a model.

## Consequences

- `packages/providers`: interface + `openai`/`anthropic`/`nvidia`/generic/local adapters
  (Phase 2), model registry with verified capabilities, health tracking, failover policy.
- Router consumes registry + reliability metrics, never provider SDKs directly.
- Capability claims verified by tests before routing depends on them (Plan §12).

## Alternatives considered

- **Per-provider SDKs in core**: rejected — couples logic to vendors, blocks local models.
- **Single generic REST adapter only**: rejected — loses typed discovery/health/streaming
  semantics; generic adapter stays as fallback for unknown endpoints.

## Security considerations

Auth values injected at call time from vault, never stored on the adapter or logged (T11).
Compromised-provider output (T6) is untrusted input to policy/tests/review. Failover obeys
data classification (no silent declassification to less-trusted providers).
