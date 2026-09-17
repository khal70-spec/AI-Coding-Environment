// Unit: egress allowlist behavior (adversarial hosts in tests/security/ssrf).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkEgress, checkRedirect } from "../../../packages/security/src/index.ts";

const ALLOW = [{ host: "registry.npmjs.org" }, { host: "api.github.com", port: 443 }];

describe("ssrf", () => {
  it("allows allowlisted https hosts", () => {
    const v = checkEgress("https://registry.npmjs.org/lodash", ALLOW);
    assert.equal(v.allowed, true);
  });

  it("denies non-allowlisted hosts (default deny)", () => {
    assert.equal(checkEgress("https://evil.TESTONLY.invalid/x", ALLOW).allowed, false);
  });

  it("denies non-http schemes and credentialed URLs", () => {
    assert.equal(checkEgress("file:///etc/passwd", ALLOW).allowed, false);
    assert.equal(checkEgress("https://user:pw@registry.npmjs.org/", ALLOW).allowed, false);
  });

  it("re-validates redirects", () => {
    const v = checkRedirect("https://registry.npmjs.org/a", "https://evil.TESTONLY.invalid/b", ALLOW);
    assert.equal(v.allowed, false);
  });
});
