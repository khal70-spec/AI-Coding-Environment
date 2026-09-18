# Phase 8 gate review — Security hardening (Plan §50)

**Verdict: PASS.** Every lane is mechanical, blocking, and fail-loud-tested. Findings from
this phase's own sweeps were hardened upstream, not documented-over.

## Delivered

| Item | Backlog | Evidence |
|---|---|---|
| P8.1 Blocking gate | `scripts/security-gate.mjs` | 4 lanes (secrets / dep-audit / supply-chain / SAST-lite), composed exit code, lane-named evidence. Fail-loudness is itself tested: `security-gate.test.mjs` plants live violations per lane (eval, XSS sink, tracked secret, runtime dep, caret pin) and proves exit 1 + named lane + green-after-cleanup. |
| P8.2 Fuzzing (IPC/parser/classifier) | `tests/security/fuzz-*.test.mjs` | Seeded PRNG (`FUZZ_SEED` replay). Bridge: 300 byte-random + 120 structured envelopes + 100 traversal paths — bounded replies, stable lanes, no server death. Classifier/injection: determinism, totality, known-danger recall, `neverExecute ⇐ blocked` honesty, planted-directive recall over noise corpora. Paths: IO-narrows-lexical invariant across 400 soup cases, homoglyph separation. Redact: per-kind specimen recall + exact clean-text preservation + random-bytes totality. |
| P8.3 Sandbox escape | `tests/security/sandbox-escape.test.mjs` | Physical proofs: write-through traversal/symlink/dir-symlink/absolutes → `JAIL_ESCAPE` + **sentinel file off-jail verified untouched**; read-through devices never return the planted secret; fs.write preflight `neverAllow`; every FS tool run-denies the escape device; terminal argv-shape hard deny (14 shapes); preflight cwd-race denial; `sanitizedEnv` constructionally omits planted env secrets; positive control still executes allowlisted argv with `$(id)` literal (not expanded). |
| P8.4 Injection red-team | `tests/security/redteam-injection.test.mjs` | 16-case corpus across 7 channels + staged combination attack; severity-floor recall; undetected-by-design rows are LABELED with compensating controls (spacing-obfuscation, multilingual) — honesty is enforced by the test itself. |
| P8.5 MCP abuse | `tests/security/mcp-abuse.test.mjs` | Byte-cap boundary (at-cap passes, 2.5MB denied), content-length lie → partial body never parses to success, mid-write child death, silent-speaker timeout bounds, 100KB param, argv metachar inertness, abuse→reuse poisoning check. |
| P8.6 Supply-chain | `scripts/supply-chain-check.mjs` | R1 zero runtime deps (15 manifests), R2 exact pins, R3 no install hooks, R4 lockfile v3/no-http/workspaces-clean. Combined with npm audit lane. `dependency-policy.md` updated to v2 (rules now machine-enforced, referenced by name). |
| P8.7 Threat-model audit | `docs/security/threat-model.md` v2.0 | Findings F1–F7 table + 4-item residual-risk log (multilingual detection, leetspeak obfuscation, unicode-steganography class, native-bridge transport re-certification). |

## Upstream hardening landed by this phase's sweeps (fix > document)

1. **Classifier**: world-writable chmod (`777/666/a+w`) now `high`; recursive world-writable
   generalized beyond the `-r 777` literal; blocked unchanged.
2. **Classifier**: interpreter inline-code flags (`python3 -c`, `node -e`, `perl -e`,
   `bash -c`, …) now `high` — arbitrary code riding a single argv arg can no longer be
   "unclassified medium".
3. **Classifier**: piped RCE generalized — curl/wget/fetch piped to bash/sh/zsh/dash/
   python/node/perl is `blocked`.
4. **Injection detector**: override-safety tolerates adjective gaps ("disregard **prior
   safety** guidelines") — closed a red-team recall hole, FP floor unchanged on clean corpus.
5. **Secret patterns**: `aws_secret_access_key` tolerates quoted (JSON/YAML) key form;
   gate lane (`scripts/check-secrets.mjs`) aligned to the same pattern.

## Gate evidence (verbatim)

- `npm test` → `# tests 565 / # pass 565 / # fail 0` (security suites: 10 lanes green
  incl. all new fuzz/escape/red-team/abuse sets)
- `npm run security:gate` → `SECURITY GATE: GREEN` — lanes: secrets-scan PASS,
  dependency-audit PASS (0 vulnerabilities), supply-chain PASS (15 manifests),
  sast-lite PASS (149 files, 0 findings, 1 visible allow)
- `npm run lint` → exit 0; `tsc --noEmit -p tsconfig.base.json` → exit 0

## Deferrals (owned)

1. **OSV-Scanner / Semgrep p/security-audit / SBOM generation + SHA-pinned CI actions** —
   remain per dependency-policy v2 as CI-side jobs; `scripts/ci/ci.yml` install lands in
   Phase 9 (release plumbing). The local blocking set covers their offline core.
2. **Model-backed injection detector / multilingual corpus** — residual risk #1/#2 in the
   threat model; current regex lane + policy gating stands as the documented boundary.
3. **Unicode-steganography hygiene class** (tag chars/bidi in model content) — residual #3.
4. **Tauri-native bridge transport re-certification** of the HTTP abuse suites — residual #4,
   bound to the Phase 7 ADR-001 divergence resolution.
