# Threat Model (Plan §44)

**Method**: STRIDE-lite per trust boundary + the 20 enumerated threats from Plan §44.
Each threat has: mitigation → test → owner → residual risk.
Owners: `core` (orchestrator/policy/tools), `sec` (security engine), `prov` (providers/router),
`mcp`, `store` (storage/secrets), `ui` (desktop/IPC), `rel` (release/supply chain).

**Trust boundaries**: renderer⇄backend, model⇄core, repo/tool/MCP-content⇄agents,
workspace⇄user-tree, app⇄network. See `docs/architecture/overview.md`.

---

## T1 — Malicious repository instructions

Repo files (README, CLAUDE.md, comments, issues) order the agent to misbehave.
- **Mitigation**: instruction hierarchy (§6); repo content is untrusted data, never system
  instructions; suspicious-instruction detection + confirmation gates (Plan §16).
- **Test**: `tests/security/prompt-injection.test.mjs`.
- **Owner**: `sec` + `core`. **Residual**: novel phrasing may evade detectors → defense in
  depth (policy engine still gates every effect).

## T2 — Prompt injection (direct/indirect)

Crafted task text, web/docs content, or tool output hijacks agent goals.
- **Mitigation**: trust labels, tool-output isolation, secret filtering, external-action
  confirmation gates (Plan §16).
- **Test**: `tests/security/prompt-injection.test.mjs`, E2E injection suites (Phase 8).
- **Owner**: `sec`. **Residual**: medium — requires ongoing detector tuning + E2E red-teaming.

## T3 — Malicious/compromised MCP server

Rogue tools, resource exfiltration, confused-deputy calls.
- **Mitigation**: per-server identity, trust level, permissions, allowed tools/resources,
  network policy, credential scoping, audit; MCP authorization spec compliance incl. HTTPS,
  PKCE, protected-resource metadata, redirect validation (ADR-005).
- **Test**: `tests/security/mcp-security.test.mjs` + integration (Phase 6).
- **Owner**: `mcp`. **Residual**: medium — server code is untrusted; containment, not trust.

## T4 — Malicious skill / plugin

Privilege escalation, data theft via extensions.
- **Mitigation**: identity + signature/integrity checks, permissions manifest, versioned
  review status, no silent elevation, install-time user consent (Plan §40/41).
- **Test**: `tests/security/plugin-security.test.mjs` (Phase 6+).
- **Owner**: `sec` + `core`. **Residual**: medium — review pipeline quality-dependent.

## T5 — Stolen API key

Key extracted from disk, memory, logs, clipboard, or model output.
- **Mitigation**: OS keychain storage, encrypted vault fallback, never in prompts/logs/DB
  plaintext, redaction everywhere, clipboard protection, rotation/revoke UX (ADR-006).
- **Test**: `tests/security/secret-*.test.mjs`, `scripts/check-secrets.mjs`, Gitleaks gate.
- **Owner**: `store`. **Residual**: low-medium — endpoint compromise out of scope.

## T6 — Compromised provider (malicious model responses)

Backdoored code suggestions, exfiltration instructions from the model channel.
- **Mitigation**: models untrusted; all output through policy + tests + scans + independent
  review; provider health tracking + failover; no provider can self-escalate routing.
- **Test**: unit (router/policy) + E2E adversarial cases (Phase 8).
- **Owner**: `prov` + `core`. **Residual**: medium — review quality is the control.

## T7 — Malicious dependency (supply chain)

Backdoored npm/crate/package payloads.
- **Mitigation**: lockfiles, minimal deps, `npm audit` + OSV gates, SBOM (Phase 8),
  integrity verification, no auto-major-upgrades (dependency-policy.md).
- **Test**: CI gates; `tests/security/supply-chain.*` (Phase 8).
- **Owner**: `rel`. **Residual**: medium — ecosystem risk; pin + scan + review.

## T8 — Shell command injection

Model/tool input smuggles destructive commands.
- **Mitigation**: no raw model commands; parse → classify → validate cwd/env → allow/deny →
  sandbox → execute → redact → audit (Plan §18); dangerous-op blocklist (Plan §9).
- **Test**: `tests/security/command-injection.test.mjs`, `tests/unit/policy/`.
- **Owner**: `sec` + `core`. **Residual**: low — allowlist-first design.

## T9 — Path traversal / file escape

`../`, symlink, absolute-path, or device-path writes outside workspace.
- **Mitigation**: canonicalize + containment checks on every fs op; symlink policy;
  workspace-root jail (Level 1 sandbox).
- **Test**: `tests/security/path-traversal.test.mjs`.
- **Owner**: `sec` + `core`. **Residual**: low.

## T10 — SSRF (incl. metadata/DNS-rebinding)

Server-side fetches hit internal hosts, metadata IPs, or exfiltrate via redirect.
- **Mitigation**: default-deny egress, per-task allowlist, redirect validation, metadata-IP
  blocklist, DNS-pinning where feasible (Plan §20).
- **Test**: `tests/security/ssrf.test.mjs`.
- **Owner**: `sec`. **Residual**: low-medium — DNS rebinding needs runtime pinning (Phase 3+).

## T11 — Secret exfiltration via model context

Secrets embedded in prompts or tool results leave to providers.
- **Mitigation**: pre-send scanning + redaction, classification-gated routing, no whole-repo
  sends, audit of chunk hashes not content (data-flow.md).
- **Test**: `tests/security/secret-redaction.test.mjs`, context-filter tests (Phase 5).
- **Owner**: `sec` + `prov`. **Residual**: low-medium — custom secret formats need patterns.

## T12 — Model hallucination presented as fact

Wrong APIs, fake test results, phantom files.
- **Mitigation**: evidence over confidence — every claim backed by command/test/scan output;
  independent reviewer; reliability metrics feed routing (Plan §34).
- **Test**: E2E evidence-completeness checks (Phase 7+).
- **Owner**: `core`. **Residual**: medium — inherent to LLMs; process contains it.

## T13 — Confused deputy (tool acts beyond intent)

Benign tool repurposed (e.g. test runner executing attacker script).
- **Mitigation**: per-agent permission manifests, tool argument validation, cwd/env pinning,
  approval for high-risk args (Plan §8/18).
- **Test**: `tests/unit/policy/`, `tests/security/permission-bypass.test.mjs`.
- **Owner**: `core`. **Residual**: low-medium.

## T14 — Privilege escalation (agent/skill/MCP)

Read-only agent gains write/exec/network.
- **Mitigation**: machine-enforced manifests, no self-modification of permissions, install
  consent, audit on every permission change (Plan §8/26).
- **Test**: `tests/security/permission-bypass.test.mjs`.
- **Owner**: `core`. **Residual**: low.

## T15 — Compromised local process / IPC abuse

Malicious renderer or local attacker drives privileged backend.
- **Mitigation**: isolated renderer, strict IPC allowlist, message validation, origin
  restrictions, OS account binding, session lock (Plan §27/28).
- **Test**: `tests/security/ipc-abuse.test.mjs` (Phase 7), IPC fuzz (Phase 8).
- **Owner**: `ui`. **Residual**: low-medium before Phase 7 IPC exists; then low.

## T16 — Supply-chain compromise of our releases

Tampered binaries/updates.
- **Mitigation**: signed builds + signed updates, publisher/signature/checksum verification,
  reproducible-build goal, rollback compat (Plan §42/47).
- **Test**: release-pipeline verification (Phase 9).
- **Owner**: `rel`. **Residual**: low after Phase 9; higher before (prerelease warning in README).

## T17 — Malicious browser content (UI testing worker)

XSS/CSRF/drive-by against the browser worker or dev server.
- **Mitigation**: isolated browser profile, dedicated test accounts (never prod creds),
  test-server-only network scope, console/network error capture (Plan §24).
- **Test**: integration (Phase 3) + E2E (Phase 8).
- **Owner**: `core`. **Residual**: medium — browser is hostile by nature; isolate it.

## T18 — Unsafe automation / schedules

Runaway scheduled tasks causing damage at 3am.
- **Mitigation**: schedules need explicit creation + scope + budget caps; high-risk actions
  in automation still require approval or pre-authorized narrow grants with expiry.
- **Test**: orchestrator schedule tests (Phase 4+).
- **Owner**: `core`. **Residual**: low-medium.

## T19 — Accidental destructive action

`rm -rf`, DB drop, force-push from a misplanned step.
- **Mitigation**: dangerous-op blocklist + approvals, checkpoints + worktrees, never destroy
  uncommitted changes, rollback support (Plan §9/21).
- **Test**: `tests/security/command-injection.test.mjs`, git-safety tests (Phase 1).
- **Owner**: `core` + `sec`. **Residual**: low.

## T20 — Cross-project data leakage

Project A context/memory leaks into Project B run.
- **Mitigation**: per-project memory scoping, no auto context sharing, classification labels
  on memory, deletion/export/retention controls (Plan §25).
- **Test**: storage scoping tests (Phase 1+), E2E isolation (Phase 8).
- **Owner**: `store` + `core`. **Residual**: low.

---

## Review cadence

Revisit this model at every phase gate and after any security incident. Changes recorded
via ADR + version note below. **v1.0 — 2026-09-17 (Phase 0 baseline).**
