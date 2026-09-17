// Unit: redaction behavior. Fixtures carry TESTONLY markers (declared fakes).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { redact, containsSecret, detectSecretKinds } from "../../../packages/security/src/index.ts";

describe("redact", () => {
  it("leaves clean text untouched", () => {
    const r = redact("hello world, no secrets here");
    assert.equal(r.redacted, false);
    assert.equal(r.text, "hello world, no secrets here");
  });

  it("redacts openai-shaped keys and reports the rule", () => {
    const r = redact('key="sk-TESTONLYabcdefghijklmnopqrstuvwxyz1234"');
    assert.equal(r.redacted, true);
    assert.ok(r.text.includes("[REDACTED:openai]"));
    assert.ok(!r.text.includes("sk-TESTONLY"));
    assert.deepEqual([...r.hits], ["openai"]);
  });

  it("redacts password assignments", () => {
    const r = redact("password=TESTONLY-SuperSecret123!");
    assert.equal(r.redacted, true);
    assert.ok(!r.text.includes("SuperSecret"));
  });

  it("redacts bearer tokens and connection strings", () => {
    const a = redact("Authorization: Bearer TESTONLY-abcdef0123456789abcdef");
    assert.equal(a.redacted, true);
    const b = redact("postgres://user:TESTONLY-pw@db.invalid:5432/app");
    assert.equal(b.redacted, true);
    assert.ok(!b.text.includes("TESTONLY-pw"));
  });

  it("containsSecret gates sends; detectSecretKinds names rules", () => {
    assert.equal(containsSecret("nothing here"), false);
    assert.equal(containsSecret("ghp_TESTONLYabcdefghijklmnopqrstuv"), true);
    assert.deepEqual([...detectSecretKinds("ghp_TESTONLYabcdefghijklmnopqrstuv")], ["github-token"]);
  });
});
