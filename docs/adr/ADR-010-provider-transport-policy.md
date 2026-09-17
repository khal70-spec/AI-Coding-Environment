# ADR-010: Provider transport policy — no redirect following, egress allowlist per provider

- **Status:** accepted
- **Date:** 2026-09-17
- **Plan refs:** §13, §20
- **Threats:** T5, T10, T11
- **Hardener for:** ADR-002 (protocol normalization), ADR-006 (vault refs)

## Context

Provider I/O is the one place the app goes to the network. Standard `fetch()`
follows 30x silently; the naive "allow the internet" posture lets a misconfigured or
compromised endpoint nudge the Authorization header onto an attacker's origin behind a
redirect. The tool-side posture (ADR security/ssrf.ts) is default-deny for untrusted
URLs; provider URLs are operator-configured but still untrusted at runtime.

## Decision

- `redirect: "error"` — **no redirect is ever followed**. Redirect ladders (auth
  header re-use, endpoint substitution) are the exfiltration path, and any legitimate
  provider exposes its final URL directly; the operator pins it at registration.
- Two URL regimes, both `http`/`https`-validated up front:
  - Remote protocols (`openai-chat`, `anthropic-messages`, `nvidia-nim`,
    `generic-rest`): https-only, no credentials in URL, private ranges and
    link-local/metadata hosts denied, host pinned by the operator's own `base_url`.
  - `local-openai-compatible`: loopback host only, http allowed, no credential
    required (auth honored when configured).
- All adapters build requests from a relative-path join against `base_url`
  (`urlFor()`), so a hostile adapter config cannot aim the same Authorization header
  at a different origin.
- Timeouts: hard (60s default, 10s health); responses are streamed through a byte cap
  (4 MiB default) — a 10 GiB response cannot exhaust memory.
- Error detail is capped to 400 bytes and passed through `redact()` before it can
  reach stderr, logs, audit rows, or the UI — provider bodies are untrusted strings.

## Consequences

- CLI `provider add` fails closed when the endpoint isn't reachable under policy
  (egress check at registration): operator sees `EGRESS_DENIED` immediately instead
  of at dispatch time.
- A corporate MITM proxy that terminates via redirect will not "just work"; operators
  must pin the provider's final URL (documented in provider README).
- Redirect support ("for that one proxy") is out-of-scope for Phase 2; if demanded,
  it requires re-adding a redirect handler that re-checks the destination against the
  original base origin — never the current hop.

## Security considerations

T5: vault refs only; the key string exists in memory only for the duration of a single
header build; errors derive from `redact()`ed response bodies capped at 400 bytes.
T10: endpoint policy is applied at registration AND at dispatch (defense-in-depth);
DNS rebinding is partially mitigated (host pinned; hostname is resolved by the OS —
private-IP *literal* targets are blocked, and HTTPS ensures certificate pin-ish
protection against a rebound remote protocol URL at TLS handshake).
T11: outbound message bodies are scanned for secret shapes before any send
(dispatcher `SECRET_IN_REQUEST`).
