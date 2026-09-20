# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 0.2.x (Phase 1 prerelease) | :white_check_mark: security fixes on `main` only |
| 0.1.x (Phase 0 prerelease) | :x: superseded — move to 0.2.x |
| Future stable releases | TBD — will be listed here with maintenance windows |

This project is pre-release. Do not use it with production credentials or
production data until it meets the **Definition of Done** (Plan §51).

## Reporting a vulnerability

**Do not open a public GitHub issue for security reports.**

- Email the maintainers (see repo contacts) with:
  - affected version/commit, component, and configuration;
  - steps to reproduce (synthetic fixtures only — no real secrets/data);
  - impact assessment and any suggested mitigation.
- Expect acknowledgment within **3 business days**.
- We follow coordinated disclosure: we will confirm, fix, and credit (if desired)
  before public disclosure. Please allow **90 days** for remediation of complex issues.

## Scope

In scope: policy engine, secret vault/redaction, workspace isolation, Git safety layer,
provider adapters, model router data handling, MCP manager/auth, tool runtime and
command classification, storage/audit, desktop IPC (once built), update/signature
verification, and all security tests under `tests/security/`.

Out of scope (for now): upstream provider APIs, OS/keychain implementations, and
third-party MCP servers/skills — but please still report suspected interaction flaws.

## Security baselines

We engineer against: OWASP ASVS, OWASP Top 10, OWASP LLM Top 10, OWASP Agentic AI
guidance, OAuth 2.1 best practices, MCP authorization specification, CWE/CVE/OSV, and
SLSA/SBOM practices where applicable (Plan §45).

## Operational requirements for contributors

- Never commit secrets; `npm run check:secrets` must pass on every PR.
- Never weaken safety checks to make tests pass.
- Security-sensitive PRs need an ADR or threat-model touch-up plus `tests/security/` coverage.
- CI security gates must pass before merge: tests (unit/security/integration),
  strict typecheck, offline secret scan, `npm audit` (high+), migration idempotency.
  The workflow is authored at `scripts/ci/ci.yml` — **upgraded 2026-09-20** with
  SHA-pinned actions and blocking OSV-Scanner/Semgrep/Trivy lanes; installation to
  `.github/workflows/` requires a maintainer token with the `workflows` permission
  (two recorded attempts, see `scripts/ci/README.md`). Run the documented local
  equivalent until a maintainer installs it.
  Lint becomes blocking in Phase 3 (ESLint config wave);
  SAST/OSV/SBOM gates become blocking in Phase 8 (see `docs/security/dependency-policy.md`).

## Telemetry

Default **OFF**. If ever enabled: no source code, no API keys, no conversation content
by default, with clear user controls (Plan §43).
