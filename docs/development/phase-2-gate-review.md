# Phase 2 Phase-Gate Review — 2026-09-17

**Gate** (per `docs/backlog/phase-2-provider-framework.md`): threat-model re-read,
Definition-of-Done spot check, decision to open Phase 3.
**Evidence base**: branch HEAD — 255/255 tests (57 suites), 13/13 workspace suites,
strict `tsc` clean, `check:secrets` clean (159 files), `npm audit` 0 vulns, migration
idempotency + live-schema drift guard green.

## 1. Threat-model re-read (posture changes vs Phase 1)

| Threat | Phase 2 posture | Runtime evidence | Residual |
|---|---|---|---|
| T5 stolen API key | **Matters now**: keys exist. Values cross only via stdin/vault→header; argv blocked by construction (CLI refuses `--value`); encrypted-file fallback + OS keyring; errors/redaction on all failure paths | `cli-providers` e2e (no value echoed anywhere), vault adapters (argv-safety), dispatcher (redacted events) | ✅ accepted |
| T6 compromised provider | First real I/O lives here. Provider marked untrusted by classification; responses redacted; cap-bounded fetch | dispatcher gates, adapter fail-closed mapping, transport tests | ✅ accepted |
| T10 SSRF | Endpoint policy at registration AND dispatch: https remote, loopback-local only, private/metadata hosts denied, no creds-in-URL, `redirect: "error"` | transport/egress matrix, CLI `provider add` denials | ✅ accepted |
| T11 secret exfil via context | Outbound message bodies scanned pre-send; `SECRET_IN_REQUEST` audited with pattern ids only | dispatcher gate tests (pattern ids in message, no values) | ✅ accepted |
| Spend/abuse | Hard-block budgets on tokens + USD-when-rates-known; append-only ledger | budget suite (windows, aggregation, pre-dispatch block) | ✅ accepted |
| Provider skipped by failover | Classification-filtered candidates; transient hops degrade status; AUTH marks unavailable; exhaustion has code-only notes | router test matrix incl. health-cache TTL | ✅ accepted |
| All other threats | Posture unchanged (kernels + later-phase deliverables per `phases-1-9.md`) | as per phase-0/1 reviews | accepted as phased |

## 2. Definition-of-Done spot check (Plan §51 — Phase 2 subset)

| DoD item | Phase 2 status |
|---|---|
| No critical/high vulns | ✅ audit clean (no new runtime deps) |
| Keys secure / never in DB or logs | ✅ vault refs only in DB; argv/stdout/log-echo all structurally blocked; encrypted-file fallback mode-verified |
| Redaction on model I/O | ✅ dispatcher + transport + CLI output all redacted (proven with planted fixture keys) |
| Dangerous ops gated | ✅ classification + egress + budget gates on every dispatch; high-risk tasks still human-gated (Phase 1) |
| Auditability | ✅ content-free events for complete/deny/fail/hop/test/budget-set/record |
| Mandatory tests/scans | ✅ 255/255 incl. failover matrix, vault round-trips, wrong-key/perm/corruption, argv-safety, budget windows |
| CLI usability as a CI gate | ✅ test/probe/budget-block all exit non-zero; `--json` everywhere operators need it |

## 3. Decision

Phase 2 is **complete**. Open item: `openai-responses` + `gemini` protocols deferred
by design (demand-gated, surface exists). Streaming and tool-calling land with Phase 3
tool system / Phase 5 routing as specified in the plan.

Tag `phase-2-complete` set; Phase 3 backlog opened: `docs/backlog/phase-3-tool-system.md`.

**Signed off**: 2026-09-17, gate review by agent-mode audit workflow (evidence cited above).
