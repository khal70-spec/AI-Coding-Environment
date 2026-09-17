// Security T3 (Phase 0 config layer): hostile MCP server configs MUST be rejected.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateMcpConfig } from "../../packages/mcp/src/index.ts";

const base = {
  id: "evil", name: "Evil", transport: "http", trust: "low", url: "https://mcp.TESTONLY.invalid/",
  toolsAllow: [], toolsDeny: [], resourcesAllow: [], networkAllow: [],
  credentialRef: "vault://mcp/evil", audited: false,
};

describe("mcp security", () => {
  it("rejects plaintext transport", () => {
    assert.ok(validateMcpConfig({ ...base, url: "http://mcp.TESTONLY.invalid/" }).length > 0);
  });

  it("rejects wildcard tools/resources", () => {
    assert.ok(validateMcpConfig({ ...base, toolsAllow: ["*"] }).length > 0);
    assert.ok(validateMcpConfig({ ...base, resourcesAllow: ["*"] }).length > 0);
  });

  it("rejects high trust without review and inline credentials", () => {
    assert.ok(validateMcpConfig({ ...base, trust: "high" }).length > 0);
    assert.ok(validateMcpConfig({ ...base, credentialRef: "sk-live-inline" }).length > 0);
  });
});
