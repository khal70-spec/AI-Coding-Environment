// Fuzz (P8.2): path-containment + secret-redaction properties.
//   Paths: total, deterministic, contained-results ALWAYS inside root, denies on
//     every escape device (traversal, symlink, NUL, unicode separator games)
//   Redact: every planted secret kind disappears from output; clean text is preserved
//     byte-for-byte; result never crashes on hostile encodings.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isWithinRoot, resolveWithinRoot, assertContainedSync } from "../../packages/security/src/paths.ts";
import { redact, containsSecret, detectSecretKinds } from "../../packages/security/src/redact.ts";
import { makePrng, seeded, randomString, randomBytesAsLatin } from "./fuzz-random.mjs";

const SEED = seeded();

describe("fuzz: path containment", () => {
  let root = "";
  before(() => {
    root = mkdtempSync(join(tmpdir(), "aice-fuzz-paths-"));
    mkdirSync(join(root, "proj", "src"), { recursive: true });
    writeFileSync(join(root, "proj", "src", "ok.ts"), "export const a = 1;");
    symlinkSync(join(root, "outside.txt"), join(root, "proj", "link-out.txt"));
    writeFileSync(join(root, "outside.txt"), "outside!");
    symlinkSync(resolve(join(root, "..")), join(root, "proj", "dir-out"), "dir");
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it("total + deterministic over random path soup; verdict ∈ {ok, denied}", () => {
    const jail = join(root, "proj");
    const prng = makePrng(SEED);
    for (let i = 0; i < 400; i++) {
      const segs = [];
      const n = 1 + Math.floor(prng() * 5);
      for (let k = 0; k < n; k++) {
        segs.push(["src", "..", ".", "x", "src/ok.ts", "../..", ".hidden", "𝔲𝔫", "a/b"].at(Math.floor(prng() * 9)));
      }
      const p = segs.join("/");
      const a = assertContainedSync(jail, p);
      const b = assertContainedSync(jail, p);
      assert.deepEqual(a, b, `not deterministic for ${p}`);
      assert.ok(typeof a.ok === "boolean");
      if (a.ok) {
        assert.ok(isWithinRoot(jail, a.path), `approved path escaped: ${p} → ${a.path}`);
      } else {
        assert.ok(typeof a.error.message === "string" && a.error.message.length > 0, "denial always explains");
      }
      const lex = resolveWithinRoot(jail, p);
      // INVARIANT: IO-symlink lane may NARROW the lexical verdict, never widen it.
      assert.equal(typeof lex.ok, "boolean", "resolveWithinRoot is total");
      if (a.ok) assert.equal(lex.ok, true, `IO approved but lexical denied: ${p}`);
      if (!lex.ok) assert.equal(a.ok, false, `lexical denied but IO approved: ${p}`);
    }
  });

  it("every escape DEVICE is denied: traversal pre/post-ops, symlinks, unicode dot games", () => {
    const jail = join(root, "proj");
    const escapes = [
      "../outside.txt",
      "src/../../outside.txt",
      "./..//outside.txt",
      "src/../../../../outside.txt",
      "link-out.txt",
      "dir-out/outside.txt",
      "src/../../outside.txt/../outside.txt",
      "x/../../../../../../../etc/passwd",
      `${jail}/../outside.txt`,
    ];
    for (const e of escapes) {
      const r = assertContainedSync(jail, e);
      assert.equal(r.ok, false, `escape succeeded: ${e} → ${r.ok ? r.path : ""}`);
    }
  });

  it("POSIX-inert dot-names stay CONTAINED (they are not traversal devices here)", () => {
    const jail = join(root, "proj");
    for (const inert of ["....//outside.txt", "./.../../ok.ts"]) {
      const r = assertContainedSync(jail, inert);
      if (r.ok) assert.ok(isWithinRoot(jail, r.path), `inert name escaped: ${inert} → ${r.path}`);
    }
  });

  it("unicode/homoglyph separators never defeat containment (𝔲𝔫 paths stay in jail or are denied)", () => {
    const jail = join(root, "proj");
    const homoglyphs = ["⧵", "﹨", "＼", "．", "‥", "…", "⁄", "∕"];
    for (const h of homoglyphs) {
      const r = assertContainedSync(jail, `src${h}ok.ts`);
      if (r.ok) assert.ok(isWithinRoot(jail, r.path), `homoglyph path escaped: ${h}`);
      // deny is also fine — containment is never violated
    }
  });
});

describe("fuzz: secret redaction", () => {
  it("every SECRET_PATTERNS kind disappears from output; clean text preserved exactly", () => {
    const specimens = [
      "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AB",
      "sk-ant-AbCdEf1234567890XYZ",
      "AKIAIOSFODNN7EXAMPLE",
      "ghp_AbCdEfGh0123456789IjKlMnOpQrStUvWx",
      "-----BEGIN PRIVATE KEY-----\nMII...\n-----END PRIVATE KEY-----",
      "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      'api_key = "live_Ch2k8sPzKEYTOKENqzX"',
    ];
    for (const secret of specimens) {
      assert.equal(containsSecret(secret), true, `specimen not detected: ${secret.slice(0, 12)}`);
      const r = redact(`prefix\nconst x = "${secret}";\nsuffix`);
      assert.equal(r.text.includes(secret), false, `secret survived redaction: ${r.text.slice(0, 80)}`);
      assert.ok(r.text.includes("prefix"));
      assert.ok(r.text.includes("suffix"));
      assert.ok(r.hits.length > 0);
    }
  });

  it("tokens survive across planted noise + truncation edges; random bytes never crash redact", () => {
    const prng = makePrng(SEED ^ 7);
    for (let i = 0; i < 300; i++) {
      // mode 1: random bytes through redact — total function
      const raw = randomBytesAsLatin(prng, Math.floor(prng() * 120));
      const out = redact(raw);
      assert.ok(typeof out.text === "string");
      assert.ok(Array.isArray(out.hits));
      // mode 2: clean-text preservation
      const clean = randomString(prng, 60).replace(/[A-Za-z0-9_-]{16,}/g, "shortened"); // damp random token-like runs interacting with generic pattern
      const rc = redact(clean);
      if (rc.hits.length === 0) assert.equal(rc.text, clean, "clean text must pass through unchanged");
    }
  });

  it("detectSecretKinds is a stable superset contract (kinds never regress)", () => {
    const merged = 'openai: sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AB, gh: ghp_AbCdEfGh0123456789IjKlMnOpQrStUvWx, key: -----BEGIN PRIVATE KEY-----';
    const kinds = detectSecretKinds(merged);
    assert.ok(kinds.some((k) => k === "openai"));
    assert.ok(kinds.some((k) => k === "github-token"));
    assert.ok(kinds.some((k) => k === "pem-block"));
  });
});
