# Phase 5 gate review — Context & routing

**Date:** 2026-09-18 · **Scope:** P5.1–P5.5 (repo index, deterministic retrieval,
filtered packing, classifier/router/escalation/vote, CLI wiring) ·
**Baseline at review:** gate suite green (474/474), tsc + lint clean.

## 1. Gate evidence

| Gate | Result |
| --- | --- |
| Unit + integration + security tests (root) | **474/474** |
| `tsc --noEmit -p tsconfig.base.json` | clean |
| `npm run lint` | 0 problems, exit 0 |
| New namespace content | `repo-index` (5), `retrieval` (4), `routing` (13), CLI context/route smoke (3) |

## 2. What exists

- **Repo index** (`packages/context/src/repo-index.ts`): deterministic lexical walk
  (sorted, bounded, symlink-free), language detection, sha256 per file, regex symbol
  extraction across TypeScript/Python/C#/PHP, internal-edge resolution for relative
  and module neighbors; secret-prone paths are excluded at the door and recorded;
  `.aice/context/index.json` persistence.
- **Retrieval** (`retrieval.ts`): keyword-of-the-task scoring — path terms (plural
  expanded, camelCase split) ×3, symbol-name overlap ×2, import adjacency, operator
  hint boosts; lexicographic tie-break (bit-for-bit determinism across independent
  builds — pinned in tests). `packWorkspace` packs ranked files through `fitBudget`.
- **Filter lane** (P5.3): `filterChunkText` = cap + `redact()` + untrusted-conforming
  body, the ONLY way repo text becomes context; chunks admit redacted text and audit
  hashes reflect exactly what was admitted (never the pre-redact bytes). Canary recall
  is measured honestly against the pattern set's own coverage — detected classes are
  filtered in one pass; undetected forms are reported, not silently dropped.
- **Routing** (`routing.ts`): pure rules — provider clearance by classification,
  `restricted` ⇒ local provider only, high risk ⇒ largest **verified** context window
  (unverified model names structurally excluded regardless of cw/cost), code/docs
  name preferences, cost-aware default, `(none)` lane with rationale for audits.
  `escalate()` bumps risk one notch; `debateVote()` fenced-verdict majority with
  keyword fallback and explicit tie→escalate (never resolved silently).
- **CLI**: `aice context build <task>` (jail = active workspace else project root;
  artifacts under `.aice/context/`; content-free audit) and `aice route <task>`
  (decision against the LIVE registry; exits 1 when nothing eligible exists).

## 3. Threat-model re-read (context-facing threats)

| Threat | Claim | Phase 5 evidence | Residual |
| --- | --- | --- | --- |
| Context leaks repo secrets to providers | layered: exclude-at-door, redact filter, chunked admission (P3+P5) | `.env`/`secrets/`/`*.pem|key` never indexed; canary classes detected in payload are filtered; dispatcher backstop still proven by P4 E2E | ✅ accepted — recall bounded by the pattern set; measured, not assumed |
| Repo crawl escapes the jail | symlink-free walk, lexical confinement, static bounds | out-of-root symlink fixtures assert both file-link and dir-link exclusion; `..` resolution of imports clamps inside root | ✅ accepted |
| Router plays favorites / nondeterministic | pure rules, id tie-breaks, rationale every time | two independent `buildRepoIndex` runs → byte-identical ranks; route task called twice → deep-equal decisions; disabled/unavailable providers can never serve | ✅ accepted |
| Risky data to under-cleared provider | path-clearance match + restricted local-only | internal-confidential blend-in test: confidential data on public-only registry yields `(none)` (exit 1); restricted task pins the local provider id | ✅ accepted |
| Vote laundering (majority theater) | strict majority or escalation | tie fixture yields `(escalate)` with named tied choices; empty exchanges escalate | ✅ accepted |

## 4. Deferred to later phases

- Agent-run integration: `aice agent run` should consume `context build` packs as
  grounding (packets per phase) and record the route decision it used. Lands with
  the task-lifecycle orchestrator (Phase 6).
- Semantic/vector retrieval (optional, offline-only embeddings) — the keyword scorer
  is the always-available floor.
- Debate/vote wired to real multi-model fanout (transports exist; fanout policy +
  budget caps belong to the router/dispatcher layer, Phase 6+).

## 5. Signature

Phase 5 objective met: context acquisition, selection, filtration, and model routing
are deterministic, offline-auditable, clearance-respecting, and already exercised by
CLI lanes — with proven recall bounds, proven determinism, and honest unavailable
lanes instead of silent downgrades.
