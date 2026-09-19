// Unit: MCP gates (P6.1) — install-time validation, endpoint rules, deny ladder.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateMcpConfig } from "../../../packages/mcp/src/index.ts";
import { decideMcpCall, mcpEndpointVerdict, assertMcpEndpoint } from "../../../packages/mcp/src/gates.ts";

const BASE = Object.freeze({
  id: "srv-fs",
  name: "fs helper",
  transport: "stdio",
  trust: "medium",
  command: ["node", "server.js"],
  toolsAllow: ["read_file", "write_file"],
  toolsDeny: ["delete_everything"],
  resourcesAllow: ["fs://tmp"],
  networkAllow: [],
  audited: false,
});

describe("MCP install validation", () => {
  it("valid base passes; wildcards/inline creds/high-trust-without-review fail", () => {
    assert.deepEqual(validateMcpConfig(BASE), []);
    assert.ok(validateMcpConfig({ ...BASE, toolsAllow: ["*"] })[0].includes("wildcard"), "wildcard forbidden");
    assert.ok(validateMcpConfig({ ...BASE, toolsDeny: ["*"] })[0].includes("wildcard"), "wildcard forbidden in deny too");
    assert.ok(validateMcpConfig({ ...BASE, credentialRef: "sk-inline-TESTONLY" })[0].includes("vault"));
    assert.ok(validateMcpConfig({ ...BASE, trust: "high", audited: false })[0].includes("review"));
    assert.ok(validateMcpConfig({ ...BASE, transport: "stdio", command: [] })[0].includes("argv"));
  });

  it("http/sse endpoint: https ok; http loopback-only", () => {
    assert.deepEqual(validateMcpConfig({ ...BASE, transport: "http", url: "https://mcp.example.test/x" }), []);
    assert.ok(!assertMcpEndpoint({ ...BASE, transport: "http", url: "http://169.254.169.254/latest" }).ok);
    assert.equal(assertMcpEndpoint({ ...BASE, transport: "http", url: "http://127.0.0.1:8787/rpc" }).ok, true);
    assert.equal(assertMcpEndpoint({ ...BASE, transport: "http", url: "http://localhost:8787/rpc" }).ok, true);
    assert.ok(!assertMcpEndpoint({ ...BASE, transport: "http", url: "http://10.1.2.3/rpc" }).ok);
    assert.ok(!assertMcpEndpoint({ ...BASE, transport: "http", url: "ftp://example.test/" }).ok);
    assert.ok(!assertMcpEndpoint({ ...BASE, transport: "http", url: "https://u:p@example.test/" }).ok, "creds in url denied");
  });
});

describe("decideMcpCall deny ladder", () => {
  it("allowlisted stdio call passes; disabled → SERVER_DISABLED", () => {
    const ok = decideMcpCall({ server: BASE, enabled: true, tool: "read_file", args: ["/tmp"] });
    assert.equal(ok.allowed, true);
    const off = decideMcpCall({ server: BASE, enabled: false, tool: "read_file" });
    assert.equal(off.allowed, false);
    assert.equal(off.code, "SERVER_DISABLED");
  });

  it("TOOLS: not-in-allow → default deny; in-deny → never allow (deny wins over allow)", () => {
    const notAllowed = decideMcpCall({ server: BASE, enabled: true, tool: "exec_shell" });
    assert.equal(notAllowed.allowed, false);
    assert.equal(notAllowed.code, "TOOL_NOT_ALLOWED");
    const gone = decideMcpCall({ server: { ...BASE, toolsAllow: ["read_file", "delete_everything"] }, enabled: true, tool: "delete_everything" });
    assert.equal(gone.allowed, false);
    assert.equal(gone.code, "TOOL_DENIED");
  });

  it("permission rows tighten (deny wins), never loosen", () => {
    const ok = decideMcpCall({ server: BASE, enabled: true, tool: "write_file" });
    assert.equal(ok.allowed, true);
    const denied = decideMcpCall({
      server: BASE,
      enabled: true,
      tool: "write_file",
      permissionRows: [{ resource: "mcp:srv-fs/write_file", effect: "deny" }],
    });
    assert.equal(denied.allowed, false);
    assert.equal(denied.code, "PERMISSION_DENIED");
    // allow-ish rows cannot loosen a default-denied tool
    const stillDenied = decideMcpCall({
      server: BASE,
      enabled: true,
      tool: "exec_shell",
      permissionRows: [{ resource: "mcp:srv-fs/exec_shell", effect: "allow" }],
    });
    assert.equal(stillDenied.allowed, false, "permission rows cannot unlock what config denies");
  });

  it("networkAllow self-listing gate: missing → blocked pre-flight; wrong host → blocked", () => {
    const remote = { ...BASE, transport: "http", url: "https://mcp.example.test/rpc", networkAllow: [] };
    const verdict = mcpEndpointVerdict(remote);
    assert.equal(verdict.blocked, true, "self-host must be allowlisted explicitly");
    const wrongHost = { ...remote, networkAllow: ["other.example.test:443"] };
    assert.equal(mcpEndpointVerdict(wrongHost).blocked, true);
    const good = { ...remote, networkAllow: ["mcp.example.test:443"] };
    const g = mcpEndpointVerdict(good);
    assert.equal(g.blocked, false, g.reason);
  });
});
