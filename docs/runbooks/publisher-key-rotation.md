# Runbook: release publisher key rotation

The signing chain (Phase 11+) is ed25519 over `dist/SHA256SUMS.txt`; the PUBLIC key
is pinned in-repo (`docs/release/publisher-key.pem`), the PRIVATE key lives outside
the repo (operator-managed; in this sandbox: `~/.publisher-key.pem`).

## Rotate (planned)
1. Generate: `node scripts/release-sign.mjs --genkey <newpath>/publisher.key.pem`
   → writes new private key to the given path and **re-pins** the tracked public key.
2. Commit the new pin ("release: rotate publisher key") alongside the first release
   that uses it; the release notes must carry the new pin's fingerprint.
3. Every dist built after the rotation MUST be signed with the new private key;
   `release-check` R11 enforces verify-before-green.

## Compromise
1. Revoke immediately: commit a pin replacement and mark the old pin as revoked in
   `docs/release/publisher-key.revoked.txt` (append date+reason).
2. Re-sign all still-current artifacts: sums files are reproducible
   (`release-verify` proves them), so re-signing is a pure signature operation —
   no content rebuild needed.
3. Announce the rotation hash (first 16 hex of new pubkey sha256) on the release channel.

## Never-do (enforced where possible)
- Never commit private keys (`*.pem`/`*.key` are gitignored; the pin is the single
  explicit allowlisted exception, annotated in `.gitignore`).
- Never sign from a fixture/test key on the production dist — fixtures use `--pin`
  into tmp and are purity-asserted (`tests/integration/release-sign.test.mjs`).
- Never verify with an operator-supplied pin on the release-track; R11 uses the
  tracked pin exactly as shipped in the archive.
