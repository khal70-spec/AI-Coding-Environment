# Phase 6 gate review — MCP & skills

**Date:** 2026-09-18 · **Scope:** P6.1–P6.4 (MCP registry/gates/contained client,
skill bundles with tamper-blocking, `aice mcp`/`aice skill` lanes) ·
**Baseline at review:** gate suite green (499/499), tsc + lint clean.

## 1. Gate evidence

| Gate | Result |
| --- | --- |
| Unit + integration + security tests (root) | **499/499** |
| `tsc --noEmit` | clean |
| `npm run lint` | 0 problems, exit 0 |
| New namespace content | mcp gates (5) + client (8) + config (4), skills (5), CLI lanes (5) |

## 2. What exists

- **Registry** (`dao-mcp.ts`, migration `005_skills.sql`): MCP server rows (config_json,
  no secrets — `vault://` refs only), generic permissions (`mcp:<id>` / `skill:<name>`
  subjects), skill rows with review state machine (`pending_review|approved|blocked`).
- **Install validation**: wildcards forbidden in BOTH allow and deny sets (wildcard
  deny = server inertness, flagged); credentials only via vault refs; high trust
  requires recorded audit; `http` is loopback-only (shared `endpoints.ts` rule used
  at install AND at call time).
- **Gate** (`gates.ts`): fixed deny ladder — CONFIG_INVALID → SERVER_DISABLED
  (per-server kill switch) → ENDPOINT_DENIED (networkAllow self-pinning: loopback
  `host:port` must match exactly; https remote passes the SSRF blocklist too) →
  TOOL_DENIED (neverAllow) → TOOL_NOT_ALLOWED (default deny) → PERMISSION_DENIED
  (rows tighten, never loosen). Portable, audit-ready reasons.
- **Client** (`client.ts`): JSON-RPC 2.0 over http(s)+stdio. Defense-in-depth
  endpoint re-check inside `call()`. Byte caps (`512KiB`), timeouts, `redirect:
  error` (no redirect following), spawn `argv`-only with `shell:false`, errors are
  lane-only strings (no endpoint normalization leaks, no content).
- **Skills** (`skills.ts`): canonical whole-bundle digest (sorted `path\0bytes`
  pairs, symlink bundles refused, 512KiB cap), namespaced permissions
  (`fs.pattern:|net:|tool:|effect:` enforced at parse), `decideSkillUse` = approved
  + live digest match ONLY. **Tamper can never be approved through**: `skill approve`
  re-digests live and flips to BLOCKED + audit row on any mismatch.
- **CLI**: `aice mcp add|list|remove|enable|disable|invoke` — install-validated adds,
  gate-checked invokes with content-free audit; `aice skill add|list|review|approve|gate`
  — review prints the consent surface (digest + declared permissions + immutability note).

## 3. Threat-model re-read (MCP/skill-facing threats)

| Threat | Claim | Phase 6 evidence | Residual |
| --- | --- | --- | --- |
| Malicious MCP server (T-class §17) | containment via config envelope + transport caps | oversize answer → cap lane; absolute-silence → timeout; dead server → lane error; non-JSON-RPC frame → refused; hostile exit codes → structured lane; stderr closed by construction | ✅ accepted — response CONTENT still passes to callers (it is untrusted data; downstream redact/trust-tagging at the agent layer stands between content and models) |
| Elevation via MCP tools | disallow shadowing: tools live as argument strings behind `mcp.<server>` subject rules; effect gates at the call site | allowlist absent → default-deny; neverAllow entries walled; permission rows can only tighten (deny wins) — CLI fixture proves both directions | ✅ accepted |
| SSRF through configured endpoints | endpoint self-pinning + SSRF blocklist | loopback `mcp add` without pin → ENDPOINT_DENIED pre-flight (audit shows deny); private/metadata hosts refused at install AND call | ✅ accepted |
| Shell tricks through stdio argv | argv-only spawn (`shell:false`), child argv is DATA | metachar probe (`; touch …`) arrives in child `process.argv` untouched, no side effects | ✅ accepted |
| Skill bundle tamper after review | whole-bundle canonical digest + approval gate | one-byte edit flips digest; approve attempt blocks + audits; blocked rows hard-deny the gate, including after tamper; symlinked bundles refused at digest time | ✅ accepted |
| Consent theater (approve without seeing) | review = the ONLY consent surface; digest + permissions printed; approve re-validates | CLI fixtures: add→gate pre-approve denied; review prints explicit permissions; approve verifies digest; gate passes only post-approve | ✅ accepted |

## 4. Deferred (honest scope)

- **OAuth for remote MCP servers**: the POC trust model is operator-configured local /
  self-hosted servers; remote OAuth lands with remote-server support (post-POC).
- **Plugin framework/marketplace UI**: MCP server rows ARE the plugin registry in
  this POC; discovery UX belongs to Phase 7+ surface.
- **Skill execution**: registry/consent shipped; skills execute inside the agent
  kernel as new tools (needs AgentRunner registry-binding — lands with the
  orchestrated lifecycle work).
- **MCP OAuth-bearer creds through `mcp.call`**: credentialRef stored but not yet
  applied to transports (vault-backed header injection lands with remote support).

## 5. Signature

Phase 6 objective met at POC strength: third-party executables can be registered,
gated, invoked, audited, and revoked with provable containment; skill bundles are
tamper-evident with human-consent approval that cannot be bypassed by mutation.
Gate remains fully green; no trust-surface additions beyond vault-referenced
credentials and operator-pinned endpoints.
