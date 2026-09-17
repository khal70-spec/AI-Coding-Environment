// Unit: lexical path containment (I/O-backed symlink cases live in tests/security/).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isWithinRoot, resolveWithinRoot } from "../../../packages/security/src/index.ts";

const ROOT = "/repo/ws";

describe("paths", () => {
  it("accepts in-workspace paths", () => {
    assert.equal(isWithinRoot(ROOT, "src/a.ts"), true);
    const r = resolveWithinRoot(ROOT, "src/a.ts");
    assert.equal(r.ok, true);
  });

  it("rejects .. escape and absolute escape", () => {
    assert.equal(isWithinRoot(ROOT, "../evil.txt"), false);
    assert.equal(isWithinRoot(ROOT, "/etc/passwd"), false);
    assert.equal(resolveWithinRoot(ROOT, "../../etc/passwd").ok, false);
  });

  it("rejects NUL, device, and UNC shapes", () => {
    assert.equal(resolveWithinRoot(ROOT, "a\0b").ok, false);
    assert.equal(resolveWithinRoot(ROOT, "\\\\server\\share").ok, false);
    assert.equal(resolveWithinRoot(ROOT, "C:\\Windows\\x").ok, false);
  });
});
