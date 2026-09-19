# Runbook: test flake triage (what to do when a suite flickers)

Policy: **never** silence a flaky test by removing/loosening it. Triage, then fix the lane.

## Ladder
1. Re-run the single file three times:
   `node --test tests/<area>/<file>.test.mjs`. ≥3/3 clean ⇒ environmental blip; record the
   incident (commit message or issue) — do NOT promote.
2. Reduce concurrency to isolate: run the affected file alone, then the full suite. A
   pass-alone/fail-together pattern ⇒ resource contention (ports, tmp dirs, journal files).
3. For TCP fixtures: never bind fixed ports (ours bind 0). For tmp fixtures: never reuse
   names (ours use mkdtempSync). For git fixtures: never share a repo between tests.
4. Statics (our two observed candidates): MCP stdio timeouts, desktop bridge e2e under
   parallel load — both use hard kill/timeouts already; a flicker there points at CI CPU
   pressure, not product logic. Confirm via the suite's own duration_ms spread.
5. If the flicker reproduces ≥2 distinct surfaces → it's a bug; write a failing fixture
   first (the corpus policy), fix the product, keep the fixture forever.

## Recordkeeping
- Note transient events in the commit message as evidence (never silently).
- `v1.0.1` line: one blank-TAP flicker observed once during a suite run under high memory
  load; two immediate re-runs 612/612; no code changed between runs.
