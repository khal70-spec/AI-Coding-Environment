#!/usr/bin/env node
// Release signing lane (Phase 11) — ed25519 signatures over the deterministic
// release artifact. Zero-dep: node:crypto only. This is the honest subset of
// "code-signing identity" available outside the native shell: every published
// tarball carries a cryptographic signature operators can verify against the
// publisher public key pinned in THIS REPO (docs/release/publisher-key.pem).
//
//   node scripts/release-sign.mjs --key /path/signing.key.pem         # sign dist/SHA256SUMS.txt
//   node scripts/release-sign.mjs --genkey /path/signing.key.pem      # generate a publisher keypair (dev lane)
//   node scripts/release-verify-sign.mjs                              # verify against pinned pubkey
//
// Fail-closed: absent sums file, malformed key, or signature mismatch all exit 1
// with an explicit message. Keys never print secret material.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { generateKeyPairSync, sign, verify as edVerify } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "../..");
const arg = (() => {
  const out = {};
  for (let i = 2; i < process.argv.length; i += 1) {
    const a = process.argv[i];
    if (!a.startsWith("--")) continue;
    const n = process.argv[i + 1];
    if (n !== undefined && !n.startsWith("--")) { out[a.slice(2)] = n; i += 1; } else { out[a.slice(2)] = true; }
  }
  return out;
})();

const distDir = typeof arg.dir === "string" ? resolve(root, arg.dir) : join(root, "dist");
const sumsPath = join(distDir, "SHA256SUMS.txt");
const sigPath = join(distDir, "SHA256SUMS.sig");
const pubPinPath = join(root, "docs/release/publisher-key.pem");

if (arg.genkey === true || typeof arg.genkey === "string") {
  const target = resolve(root, typeof arg.genkey === "string" ? arg.genkey : "/dev/null");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(target, privateKey.export({ type: "pkcs8", format: "pem" }));
  writeFileSync(pubPinPath, publicKey.export({ type: "spki", format: "pem" }));
  console.error(`release-sign: NEW publisher key → private ${target} (GUARD IT, never commit) + public pinned ${join("docs", "release", "publisher-key.pem")}`);
  process.exit(0);
}

if (typeof arg.key !== "string") {
  console.error("release-sign: FAILED — --key <private-key.pem> required (or --genkey <path> for the dev lane)");
  process.exit(1);
}
if (!existsSync(sumsPath)) { console.error(`release-sign: FAILED — ${join("SHA256SUMS.txt")} absent in ${distDir}; run release-prepare first`); process.exit(1); }
const keyPem = readFileSync(resolve(root, arg.key), "utf8");
const payload = readFileSync(sumsPath);
try {
  const sig = sign(null, payload, keyPem); // ed25519: no hash algorithm param
  writeFileSync(sigPath, JSON.stringify({
    alg: "ed25519",
    keySource: "docs/release/publisher-key.pem",
    signature: Buffer.from(sig).toString("base64"),
    payload: "SHA256SUMS.txt",
  }, null, 2) + "\n");
  console.error(`release-sign: signed SHA256SUMS.txt → ${join("dist", "SHA256SUMS.sig")} (${sig.length} bytes ed25519)`); // constant 64
} catch (e) {
  console.error(`release-sign: FAILED — ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
export { sigPath, sumsPath, pubPinPath, edVerify }; // consumed by release-verify-sign.mjs
