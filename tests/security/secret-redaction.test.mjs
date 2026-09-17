// Security T5/T11: realistic secret shapes MUST be detected + redacted.
// All fixtures are synthetic and carry TESTONLY markers (declared fakes).
// This file is allowlisted from scanners — see secret-policy.md.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { redact, containsSecret } from "../../packages/security/src/index.ts";

const CASES = [
  ["openai", 'api_key = "sk-TESTONLY-abcdefghijklmnopqrstuvwx1234"'],
  ["openai-proj", "sk-proj-TESTONLY-abcdefghijklmnopqrstuvwx1234"],
  ["anthropic", "sk-ant-TESTONLY-api03-abcdefghijklmnop"],
  ["aws-access", "AKIAIOSFODNN7TESTONL"],
  ["github", "ghp_TESTONLYabcdefghijklmnopqrstuv0123"],
  ["gitlab", "glpat-TESTONLY-abcdefghijklmnop"],
  ["google", "AIzaTESTONLY-abcdefghijklmnopqrstuvwxyza1"],
  ["jwt", "eyJTESTONLY-header12.eyJTESTONLY-payl04d.SflKTESTONLY-signatur3"],
  ["pem", "-----BEGIN RSA PRIVATE KEY----- TESTONLY-fake-body"],
  ["bearer", "Bearer TESTONLY-abcdef0123456789abcdef"],
  ["connstr", "mongodb+srv://user:TESTONLY-pw@cluster.invalid/db"],
  ["passwd", "password: TESTONLY-hunter2-hunter2"],
];

describe("secret redaction (adversarial shapes)", () => {
  for (const [name, sample] of CASES) {
    it(`detects + redacts ${name}`, () => {
      assert.equal(containsSecret(sample), true, name);
      const r = redact(`prefix ${sample} suffix`);
      assert.equal(r.redacted, true, name);
      assert.ok(!r.text.includes("TESTONLY-") || r.text.includes("[REDACTED:"), name);
      assert.ok(r.text.includes("[REDACTED:"), name);
    });
  }

  it("redacts multiple secrets in one blob", () => {
    const blob = `a=sk-TESTONLY-abcdefghijklmnopqrstuvwx1234 b=password: TESTONLY-x1234`;
    const r = redact(blob);
    assert.equal(r.hits.length >= 2, true);
    assert.ok(!r.text.includes("sk-TESTONLY"));
    assert.ok(!r.text.includes("TESTONLY-x1234"));
  });
});
