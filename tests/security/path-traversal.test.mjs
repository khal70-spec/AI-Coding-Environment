// Security T9: traversal / escape attempts MUST fail closed (lexical + symlink-aware).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWithinRoot, assertContainedSync } from "../../packages/security/src/index.ts";

const ATTACKS = [
  "../evil.txt",
  "../../etc/passwd",
  "..\\..\\windows\\win.ini",
  "/etc/passwd",
  "/tmp/evil",
  "sub/../../../../evil",
];

// Filter-evasion spellings that are lexically CONTAINED (plain directory names —
// our fs layer never URL-decodes or collapses dots, so they cannot escape).
const CONTAINED_NOOPS = ["....//....//etc/passwd", "%2e%2e/%2e%2e/x"];

describe("path traversal (lexical)", () => {
  const root = "/repo/ws";
  for (const a of ATTACKS) {
    it(`rejects ${a}`, () => {
      assert.equal(resolveWithinRoot(root, a).ok, false, a);
    });
  }
  it("rejects absolute in-root lookalikes (/repo/ws-evil)", () => {
    assert.equal(resolveWithinRoot(root, "/repo/ws-evil/x").ok, false);
  });

  for (const n of CONTAINED_NOOPS) {
    it(`contains no-op evasion spelling: ${n}`, () => {
      const r = resolveWithinRoot(root, n);
      assert.equal(r.ok, true, n);
      assert.ok(r.path.startsWith(`${root}/`), n);
    });
  }
});

describe("path traversal (symlink-aware)", () => {
  let dir = "";
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "aice-trav-"));
    mkdirSync(join(dir, "ws"));
    writeFileSync(join(dir, "outside.txt"), "outside");
    symlinkSync(join(dir, "outside.txt"), join(dir, "ws", "link-evil"));
    symlinkSync("/etc", join(dir, "ws", "link-etc"));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("blocks symlink pointing outside workspace", () => {
    const r = assertContainedSync(join(dir, "ws"), "link-evil");
    assert.equal(r.ok, false);
  });

  it("blocks symlink to /etc", () => {
    const r = assertContainedSync(join(dir, "ws"), "link-etc/passwd");
    assert.equal(r.ok, false);
  });
});
