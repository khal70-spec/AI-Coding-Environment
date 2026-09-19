#!/usr/bin/env node
// Release signature verification — ed25519 over dist/SHA256SUMS.txt against the
// publisher public key PINNED IN THIS REPO. Companion to release-sign.mjs.
// Exit 0 only when: pinned pubkey present + signature file parses + ed25519
// verify succeeds. Unsigned-but-valid releases print a NOTE (R11 in
// release-check is the enforcement row).
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { verify as edVerify } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "../..");
const dirIdx = process.argv.indexOf("--dir");
const distDir = dirIdx >= 0 && process.argv[dirIdx + 1] !== undefined ? resolve(root, process.argv[dirIdx + 1]) : join(root, "dist");
const sumsPath = join(distDir, "SHA256SUMS.txt");
const sigPath = join(distDir, "SHA256SUMS.sig");
const pubPinPath = join(root, "docs/release/publisher-key.pem");
const strict = process.argv.includes("--require-signature");


if (!existsSync(sigPath)) {
  const msg = `release-verify-sign: no signature file (${sigPath})`;
  if (strict) { console.error(`${msg} — and --require-signature was set`); process.exit(1); }
  console.error(`${msg} — unsigned release (acceptable for dev; never for publication)`);
  process.exit(0);
}
for (const [label, p] of [["pinned publisher key", pubPinPath], ["sums payload", sumsPath]]) {
  if (!existsSync(p)) { console.error(`release-verify-sign: FAILED — ${label} missing (${p})`); process.exit(1); }
}
let sigRecord;
try {
  sigRecord = JSON.parse(readFileSync(sigPath, "utf8"));
} catch (e) {
  console.error(`release-verify-sign: FAILED — signature file unparsable: ${e.message}`);
  process.exit(1);
}
if (sigRecord.alg !== "ed25519" || typeof sigRecord.signature !== "string") {
  console.error("release-verify-sign: FAILED — signature record shape mismatch (alg must be ed25519)");
  process.exit(1);
}
const ok = edVerify(null, readFileSync(sumsPath), readFileSync(pubPinPath, "utf8"), Buffer.from(sigRecord.signature, "base64"));
if (!ok) {
  console.error("release-verify-sign: FAILED — SIGNATURE MISMATCH (tamper or wrong publisher key)");
  process.exit(1);
}
console.error("release-verify-sign: OK — ed25519 signature verifies against pinned publisher key");
process.exit(0);
