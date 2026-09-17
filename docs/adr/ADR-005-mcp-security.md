# ADR-005: MCP manager security model

- **Status:** accepted
- **Date:** 2026-09-17
- **Plan refs:** §17, §18, §26
- **Threats:** T3, T10, T11, T13

## Context

MCP servers (GitHub, DBs, browsers, cloud, trackers) are powerful and untrusted. We need
first-class MCP support without letting a server become a confused deputy or exfil channel.

## Decision

Every MCP server gets a registered identity with explicit security posture:

```yaml
server: github-main
transport: http
trust: low                 # low | medium | high — high requires review + signature
tools: { allow: [issues.read, pr.read], deny: ["*"] }  # deny-by-default
resources: { allow: ["repo:acme/app:read"], deny: ["*"] }
network: { allow: [{ host: api.github.com, port: 443 }] }
credentials: { ref: vault://mcp/github-main }          # scoped token, least privilege
audit: true
```

Authorization follows the current MCP authorization specification: HTTPS, PKCE, protected
resource metadata, redirect validation, token-storage/rotation hygiene. No weaker custom auth.

## Consequences

- `packages/mcp` (Phase 6): registry, permission enforcement, OAuth flows, health, audit.
- MCP tool calls flow through the same policy engine as built-in tools (allow/approval/deny).
- Server prompts/resources treated as untrusted data (prompt-injection rules apply).

## Alternatives considered

- **Allowlist-free MCP passthrough**: rejected — gives servers ambient authority.
- **Custom token scheme**: rejected — spec compliance beats novelty for auth.

## Security considerations

Malicious server (T3) contained by deny-by-default tools/resources + network policy.
SSRF (T10) via server URLs blocked by egress checks. Abuse tests in
`tests/security/mcp-security.test.mjs` + Phase 6 integration.
