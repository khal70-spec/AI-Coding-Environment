# Data Flow & Data Classification (Plan §15, §35, §36)

## Classification

| Level | Meaning | Provider rule |
|---|---|---|
| Public | publishable | any enabled provider |
| Internal | normal project code | approved cloud providers |
| Confidential | sensitive business logic, non-prod secrets refs | approved providers only |
| Restricted | credentials, PII, prod data, security-sensitive | **local models only** |

Project default: **Internal**. Files/paths can raise classification (e.g. `**/*.pem`
→ Restricted). Router + failover must obey classification; fallback that would
declassify context is denied and the task blocks with an explanation.

## Context assembly (per agent call)

```text
repo map + symbol index + dep graph + search hits + git history + tests/docs
  → classification labeling (per chunk)
  → secret/PII filtering (redact unless explicitly authorized)
  → budget trim (max context per model/task)
  → provider adapter (minimum context for this operation)
  → audit (what was sent: hashes + chunk ids, NEVER content with secrets)
```

Whole-repo sends are prohibited. Cross-project context sharing is prohibited (Plan §25).

## Secret handling

- Keys live in OS credential store / encrypted vault; app code holds handles, not values.
- Values are injected only into provider HTTPS requests, never into prompts, logs, or state.
- All tool output and model input pass redaction (`packages/secrets`, `packages/security`).
- Audit stores redacted summaries + hashes, never raw secrets (Plan §26).

## Network flow

Default DENY. Per-task allowlist entries: `{ host, port, purpose, approvedBy, expiresAt }`.
Blocked always: loopback probing outside approved test servers, private-IP ranges (unless
explicit project allowlist), cloud metadata IPs, arbitrary ports. SSRF checks on every
server-side fetch including redirects (Plan §20).
