// Unit: MCP server config validation (ADR-005).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateMcpConfig } from "../../../packages/mcp/src/index.ts";

const good = {
  id: "github-main", name: "GitHub", transport: "http", trust: "low",
  url: "https://mcp.TESTONLY.invalid/", toolsAllow: ["issues.read"], toolsDeny: [],
  resourcesAllow: ["repo:acme/app:read"], networkAllow: ["mcp.TESTONLY.invalid"],
  credentialRef: "vault://mcp/github-main", audited: true,
};

describe("mcp config", () => {
  it("accepts a least-privilege server", () => {
    assert.equal(validateMcpConfig(good).length, 0);
  });

  it("rejects http, wildcards, high-trust-without-review, inline creds", () => {
    assert.ok(validateMcpConfig({ ...good, url: "http://x/" }).length > 0);
    assert.ok(validateMcpConfig({ ...good, toolsAllow: ["*"] }).length > 0);
    assert.ok(validateMcpConfig({ ...good, trust: "high", audited: false }).length > 0);
    assert.ok(validateMcpConfig({ ...good, credentialRef: "inline-secret" }).length > 0);
    assert.ok(validateMcpConfig({ ...good, transport: "stdio", command: [] }).length > 0);
  });
});
