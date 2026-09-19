// Phase 11: release signing lane — ed25519 over SHA256SUMS.txt against the pinned
// publisher key. Cover: sign→verify OK, tampered payload → FAIL, wrong key → FAIL,
// unsigned-when-required → FAIL.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL("../..", import.meta.url)), "");
const SIGN = "scripts/release-sign.mjs";
const VERIFY = "scripts/release-verify-sign.mjs";

function run(file, args) {
  return spawnSync(process.execPath, [file, ...args], { cwd: root, encoding: "utf8", timeout: 60_000 });
}

test("release-sign: full round trip + tamper refusal (fail-closed)", () => {
  const work = mkdtempSync(join(tmpdir(), "aice-sign-"));
  try {
    // synthetic release dir
    writeFileSync(join(work, "SHA256SUMS.txt"), `${"ab".repeat(32)}  app.tar.gz\n`);
    const priv = join(work, "publisher.key.pem");
    assert.equal(run(SIGN, ["--genkey", priv]).status, 0);
    // pinned pubkey is repo-side, rewritten by --genkey → capture now
    const pubPin1 = readFileSync(join(root, "docs/release/publisher-key.pem"), "utf8");
    assert.ok(pubPin1.includes("PUBLIC KEY"));
    // sign
    const s = run(SIGN, ["--key", priv, "--dir", work]);
    assert.equal(s.status, 0, s.stderr);
    assert.equal(run(VERIFY, ["--dir", work, "--require-signature"]).status, 0);
    // tamper the payload → verify must FAIL
    writeFileSync(join(work, "SHA256SUMS.txt"), `${"cd".repeat(32)}  app.tar.gz\n`);
    const bad = run(VERIFY, ["--dir", work, "--require-signature"]);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /SIGNATURE MISMATCH/);
    // restore + wrong key → FAIL
    writeFileSync(join(work, "SHA256SUMS.txt"), `${"ab".repeat(32)}  app.tar.gz\n`);
    const other = mkdtempSync(join(tmpdir(), "aice-sign2-"));
    try {
      const priv2 = join(other, "publisher.key.pem");
      assert.equal(run(SIGN, ["--genkey", priv2]).status, 0);
      const s2 = run(SIGN, ["--key", priv2, "--dir", work]);
      assert.equal(s2.status, 0);
      // re-pin the FALSE publisher pubkey came from second genkey → verify now fails
      assert.equal(run(VERIFY, ["--dir", work, "--require-signature"]).status, 0);
      const mismatch = spawnSync(process.execPath, [VERIFY, "--dir", work, "--require-signature"], { cwd: root, encoding: "utf8" });
      assert.equal(mismatch.status, 0);
      // now check against ORIGINAL pubkey by restoring pub pin
      writeFileSync(join(root, "docs/release/publisher-key.pem"), pubPin1);
      const wrongKey = run(VERIFY, ["--dir", work, "--require-signature"]);
      assert.equal(wrongKey.status, 1);
    } finally {
      rmSync(other, { recursive: true, force: true });
      // restore the pinned publisher pubkey to the canonical test pair
      writeFileSync(join(root, "docs/release/publisher-key.pem"), pubPin1);
    }
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test("release-verify-sign: unsigned + --require-signature → exit 1; unsigned + dev lane → exit 0 NOTE", () => {
  const work = mkdtempSync(join(tmpdir(), "aice-sign3-"));
  try {
    writeFileSync(join(work, "SHA256SUMS.txt"), `${"ab".repeat(32)}  app.tar.gz\n`);
    const req = run(VERIFY, ["--dir", work, "--require-signature"]);
    assert.equal(req.status, 1);
    const dev = run(VERIFY, ["--dir", work]);
    assert.equal(dev.status, 0);
    assert.match(dev.stderr, /unsigned release/);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test("release-sign: absent sums file → explicit fail-closed message", () => {
  const work = mkdtempSync(join(tmpdir(), "aice-sign4-"));
  try {
    const priv = join(work, "k.pem");
    assert.equal(run(SIGN, ["--genkey", priv]).status, 0);
    const r = run(SIGN, ["--key", priv, "--dir", work]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /absent/);
  } finally { rmSync(work, { recursive: true, force: true }); }
});
