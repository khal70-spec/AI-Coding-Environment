// Security T10: SSRF hosts MUST be denied even when allowlisted by name-confusion.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkEgress } from "../../packages/security/src/index.ts";

const ALLOW = [{ host: "registry.npmjs.org" }];

const DENIED = [
  "http://localhost:3000/admin",
  "http://127.0.0.1/",
  "http://127.1/",
  "http://0.0.0.0/",
  "http://10.0.0.5/",
  "http://172.16.0.9/",
  "http://192.168.1.1/",
  "http://169.254.169.254/latest/meta-data/",
  "http://metadata.google.internal/",
  "http://[::1]/",
  "http://[::ffff:127.0.0.1]/",
  "gopher://registry.npmjs.org:70/x",
  "file:///etc/passwd",
];

describe("ssrf", () => {
  for (const u of DENIED) {
    it(`denies ${u}`, () => {
      assert.equal(checkEgress(u, ALLOW).allowed, false, u);
    });
  }

  it("denies allowlisted host on wrong port", () => {
    assert.equal(checkEgress("https://registry.npmjs.org:8443/x", ALLOW).allowed, false);
  });

  it("denies userinfo smuggling", () => {
    assert.equal(checkEgress("https://registry.npmjs.org@evil.invalid/", ALLOW).allowed, false);
  });
});
