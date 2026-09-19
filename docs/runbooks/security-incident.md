# Runbook: security incident response

Owner lane: security-gate machinery (`scripts/security-gate.mjs`) + threat-model.

## 1. Triage (minutes)
- `npm run security:gate` — any RED lane is the blast radius indicator.
- Secrets lane RED → operator reports: rotation runbook (`docs/security/secret-policy.md`).
- `aice doctor` on affected projects; `node scripts/db-backup.mjs` BEFORE any repair.

## 2. Suspected prompt-injection (agent phases)
- Finding rows land in `findings` via the injection detector (`detectSuspiciousInstructions`,
  including the canonical unicode lane). Query: `npx aice task show <id>` → findings table.
- The display-only lane guarantees transcripts never execute; quarantine = revoke
  the MCP server (`mcp.toggle` / CLI `mcp disable`) and record a `findings add -severity high`.

## 3. Signature / artifact integrity worry
- `node scripts/release-verify-sign.mjs --require-signature` — exits 1 on mismatch.
- `node scripts/release-verify.mjs` — byte-identical rebuild comparison.
- If both pass, the artifact chain is sound; investigate downstream (operator-side tamper).

## 4. Compromise containment
- Provider keys: `aice provider key remove|set --stdin` rotation per `secret-policy.md`.
- DB forensic copy: checkpoint archived in backups (`db-backup`).
- Town-hall evidence: append audit note via any CLI lane; audit is append-only and
  content-free, so incident metadata stays forensically clean.

## 5. Post-incident
- Extend the red-team corpus (tests/security/*) with the attack that tripped you —
  every incident becomes a fixture. Update threat-model residuals if a new class emerged.
