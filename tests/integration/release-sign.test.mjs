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
    const pub1 = join(work, "pub1.pem");
    assert.equal(run(SIGN, ["--genkey", priv, "--pin", pub1]).status, 0);
    // REPO PIN MUST NEVER CHANGE during fixtures — fixture purity guard
    const repoPinBefore = readFileSync(join(root, "docs/release/publisher-key.pem"), "utf8");
    const pubPin1 = readFileSync(pub1, "utf8");
    assert.ok(pubPin1.includes("PUBLIC KEY"));
    // sign
    const s = run(SIGN, ["--key", priv, "--dir", work]);
    assert.equal(s.status, 0, s.stderr);
    // the verify lane uses an explicit --pin to keep fixtures repo-pure
    assert.equal(run(VERIFY, ["--dir", work, "--require-signature", "--pin", pub1]).status, 0);
    // isolation the other way: fixture-signed payload must NOT verify against the repo pin
    const againstRepo = run(VERIFY, ["--dir", work, "--require-signature"]);
    assert.ok(againstRepo.status === 1 || readFileSync(join(root, "docs/release/publisher-key.pem"), "utf8") === pubPin1,
      againstRepo.stderr);
    // tamper the payload → verify must FAIL
    writeFileSync(join(work, "SHA256SUMS.txt"), `${"cd".repeat(32)}  app.tar.gz\n`);
    const bad = run(VERIFY, ["--dir", work, "--require-signature", "--pin", pub1]);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /SIGNATURE MISMATCH/);
    // restore + wrong key → FAIL (all pins in tmp, never the repo)
    writeFileSync(join(work, "SHA256SUMS.txt"), `${"ab".repeat(32)}  app.tar.gz\n`);
    const other = mkdtempSync(join(tmpdir(), "aice-sign2-"));
    try {
      const priv2 = join(other, "publisher.key.pem");
      const pub2 = join(other, "pub2.pem");
      assert.equal(run(SIGN, ["--genkey", priv2, "--pin", pub2]).status, 0);
      const s2 = run(SIGN, ["--key", priv2, "--dir", work]);
      assert.equal(s2.status, 0);
      const ownPin = run(VERIFY, ["--dir", work, "--require-signature", "--pin", pub2]);
      assert.equal(ownPin.status, 0);
      const wrongKey = run(VERIFY, ["--dir", work, "--require-signature", "--pin", pub1]);
      assert.equal(wrongKey.status, 1);
      assert.match(wrongKey.stderr, /SIGNATURE MISMATCH/);
    } finally { rmSync(other, { recursive: true, force: true }); }
    // repo pin untouched by fixtures
    assert.equal(readFileSync(join(root, "docs/release/publisher-key.pem"), "utf8"), repoPinBefore);
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
    assert.equal(run(SIGN, ["--genkey", priv, "--pin", join(work, "k.pub.pem")]).status, 0);
    const r = run(SIGN, ["--key", priv, "--dir", work]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /absent/);
  } finally { rmSync(work, { recursive: true, force: true }); }
});
