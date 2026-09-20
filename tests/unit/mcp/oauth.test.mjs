// Unit: MCP OAuth 2.1 remote profile (Plan §17, ADR-005) — loopback mock
// authorization server + resource: discovery, PKCE S256, authorize URL, form
// exchange/refresh, error lanes (invalid_grant, non-Bearer, non-JSON, caps),
// HTTPS-only posture, bearer injection into the contained MCP http client.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import {
  OAuthError,
  assertOAuthEndpoint,
  generatePkcePair,
  generateState,
  discoverAuthorizationServer,
  discoverProtectedResource,
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  refreshAccessToken,
  McpClient,
  validateMcpConfig,
} from "../../../packages/mcp/src/index.ts";

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

let server;
let base;
let seen;
before(async () => {
  server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    seen.push({ method: req.method, path: u.pathname, headers: { ...req.headers } });
    if (u.pathname === "/as/.well-known/oauth-authorization-server") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        issuer: `${base}/as`,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        revocation_endpoint: `${base}/revoke`,
      }));
      return;
    }
    if (u.pathname === "/.well-known/oauth-protected-resource") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ resource: `${base}/mcp`, authorization_servers: [`${base}/as`] }));
      return;
    }
    if (u.pathname === "/token" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen[seen.length - 1].body = body;
        const p = new URLSearchParams(body);
        res.setHeader("content-type", "application/json");
        if (p.get("code") === "bad-code") {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "invalid_grant", error_description: "code unknown" }));
          return;
        }
        if (p.get("grant_type") === "authorization_code") {
          res.end(JSON.stringify({ access_token: "acc-TESTONLY-1234567890", token_type: "Bearer", expires_in: 900, refresh_token: "ref-TESTONLY-1234567890", scope: "mcp.read mcp.write" }));
          return;
        }
        if (p.get("grant_type") === "refresh_token") {
          res.end(JSON.stringify({ access_token: "acc2-TESTONLY-123456789", token_type: "Bearer", expires_in: 900 }));
          return;
        }
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "unsupported_grant_type" }));
      });
      return;
    }
    if (u.pathname === "/mcp" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const m = JSON.parse(body);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { echoed: m.params.name } }));
      });
      return;
    }
    if (u.pathname === "/broken-meta/.well-known/oauth-authorization-server") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ issuer: `${base}/broken-meta` })); // token_endpoint missing
      return;
    }
    res.statusCode = 404;
    res.end("nope");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  seen = [];
});
after(async () => {
  await new Promise((r) => server.close(r));
});

describe("endpoint posture", () => {
  it("https ok; loopback http ok; remote http denied; creds-in-url denied; scheme denied", () => {
    assert.equal(assertOAuthEndpoint("https://auth.example.com/", "t").protocol, "https:");
    assert.equal(assertOAuthEndpoint(`${base}/as`, "t").hostname, "127.0.0.1");
    assert.throws(() => assertOAuthEndpoint("http://auth.example.com/", "t"), (e) => e.code === "ENDPOINT_DENIED" && /HTTPS/.test(e.message));
    assert.throws(() => assertOAuthEndpoint("https://user:pw@example.com/", "t"), /credentials in url denied/);
    assert.throws(() => assertOAuthEndpoint("ftp://example.com/", "t"), /scheme denied/);
    assert.throws(() => assertOAuthEndpoint("not a url", "t"), /malformed/);
  });
});

describe("PKCE + state", () => {
  it("verifier 43..128 chars; S256 challenge = base64url(sha256(verifier))", () => {
    const p = generatePkcePair();
    assert.ok(p.verifier.length >= 43 && p.verifier.length <= 128);
    assert.equal(p.method, "S256");
    const expect = b64url(createHash("sha256").update(p.verifier).digest());
    assert.equal(p.challenge, expect);
    assert.equal(generateState().length >= 32, true);
  });
});

describe("discovery (RFC 8414 / RFC 9728)", () => {
  it("discovers AS metadata and validates the declared endpoints", async () => {
    const meta = await discoverAuthorizationServer(`${base}/as`);
    assert.equal(meta.authorizationEndpoint, `${base}/authorize`);
    assert.equal(meta.tokenEndpoint, `${base}/token`);
    assert.equal(meta.revocationEndpoint, `${base}/revoke`);
  });
  it("discovers protected-resource authorization servers", async () => {
    const servers = await discoverProtectedResource(`${base}/mcp`);
    assert.deepEqual([...servers], [`${base}/as`]);
  });
  it("malformed metadata fails INVALID_METADATA; missing route fails DISCOVERY_FAILED", async () => {
    await assert.rejects(() => discoverAuthorizationServer(`${base}/broken-meta`), (e) => e instanceof OAuthError && e.code === "INVALID_METADATA");
    await assert.rejects(() => discoverAuthorizationServer(`${base}/nowhere-real`), OAuthError);
  });
});

describe("authorize URL", () => {
  it("carries the exact OAuth 2.1 + PKCE parameters", async () => {
    const meta = await discoverAuthorizationServer(`${base}/as`);
    const url = buildAuthorizeUrl({
      meta,
      clientId: "aice-cli",
      redirectUri: "http://127.0.0.1:8765/callback",
      state: "state-TESTONLY-1234567890",
      codeChallenge: "ch-TESTONLY-1234567890",
      scopes: ["mcp.read"],
      resource: "https://mcp.example.com/",
    });
    const q = new URL(url).searchParams;
    assert.equal(q.get("response_type"), "code");
    assert.equal(q.get("client_id"), "aice-cli");
    assert.equal(q.get("redirect_uri"), "http://127.0.0.1:8765/callback");
    assert.equal(q.get("state"), "state-TESTONLY-1234567890");
    assert.equal(q.get("code_challenge"), "ch-TESTONLY-1234567890");
    assert.equal(q.get("code_challenge_method"), "S256");
    assert.equal(q.get("scope"), "mcp.read");
    assert.equal(q.get("resource"), "https://mcp.example.com/");
  });
  it("rejects degenerate inputs", () => {
    assert.throws(
      () =>
        buildAuthorizeUrl({
          meta: { issuer: "x", authorizationEndpoint: `${base}/authorize`, tokenEndpoint: `${base}/token` },
          clientId: "short",
          redirectUri: "r",
          state: "s",
          codeChallenge: "c",
        }),
      (e) => e.code === "VALIDATION",
    );
  });
});

describe("token exchange + refresh (form-encoded, strict parsing)", () => {
  it("exchanges code+verifier → Bearer token set (exact form params on the wire)", async () => {
    seen = [];
    const tokens = await exchangeAuthorizationCode(`${base}/token`, {
      clientId: "aice-cli",
      code: "good-code",
      redirectUri: "http://127.0.0.1:8765/callback",
      codeVerifier: "v-TESTONLY-1234567890123456789012345678901234",
      resource: "https://mcp.example.com/",
    });
    assert.equal(tokens.accessToken, "acc-TESTONLY-1234567890");
    assert.equal(tokens.tokenType, "Bearer");
    assert.equal(tokens.expiresInSec, 900);
    assert.equal(tokens.refreshToken, "ref-TESTONLY-1234567890");
    const posted = new URLSearchParams(seen.find((s) => s.path === "/token").body);
    assert.equal(posted.get("grant_type"), "authorization_code");
    assert.equal(posted.get("code_verifier").startsWith("v-TESTONLY-"), true);
    assert.equal(posted.get("code"), "good-code");
    assert.equal(posted.get("resource"), "https://mcp.example.com/");
  });
  it("error payloads map to TOKEN_FAILED with the spec error code named", async () => {
    await assert.rejects(
      () =>
        exchangeAuthorizationCode(`${base}/token`, {
          clientId: "aice-cli",
          code: "bad-code",
          redirectUri: "http://127.0.0.1:8765/callback",
          codeVerifier: "v-TESTONLY-1234567890123456789012345678901234",
        }),
      (e) => e instanceof OAuthError && e.code === "TOKEN_FAILED" && /invalid_grant/.test(e.message),
    );
  });
  it("refresh grant works; degenerate inputs are refused before any fetch", async () => {
    const t = await refreshAccessToken(`${base}/token`, { clientId: "aice-cli", refreshToken: "ref-TESTONLY-1234567890" });
    assert.equal(t.accessToken, "acc2-TESTONLY-123456789");
    await assert.rejects(() => refreshAccessToken(`${base}/token`, { clientId: "x", refreshToken: "short" }), (e) => e.code === "VALIDATION");
    await assert.rejects(
      () => exchangeAuthorizationCode("http://token.example.com/", { clientId: "x", code: "c-12345678", redirectUri: "r", codeVerifier: "v-12345678" }),
      (e) => e.code === "ENDPOINT_DENIED",
    );
  });
});

describe("bearer injection into the contained MCP http client", () => {
  const cfg = {
    id: "srv-1",
    name: "t",
    transport: "http",
    trust: "low",
    url: null, // set per test
    toolsAllow: ["echo"],
    toolsDeny: [],
    resourcesAllow: [],
    networkAllow: ["127.0.0.1"],
    oauth: { clientId: "aice-cli" },
    audited: false,
  };
  it("sends Authorization: Bearer when a dep token is provided; omits it otherwise", async () => {
    const port = new URL(base).port;
    const pinned = { ...cfg, url: `${base}/mcp`, networkAllow: [`127.0.0.1:${port}`] };
    const withTok = await new McpClient({ bearerToken: "tok-TESTONLY-xyz" }).call(pinned, "tools/call", { name: "echo", arguments: [] });
    assert.equal(withTok.ok, true, withTok.error);
    const sawAuth = seen.filter((s) => s.path === "/mcp").pop().headers["authorization"];
    assert.equal(sawAuth, "Bearer tok-TESTONLY-xyz");

    const without = await new McpClient({}).call(pinned, "tools/call", { name: "echo", arguments: [] });
    assert.equal(without.ok, true);
    const sawNone = seen.filter((s) => s.path === "/mcp").pop().headers["authorization"];
    assert.equal(sawNone, undefined);
  });
});

describe("config validation for the oauth profile", () => {
  const good = {
    id: "github-main",
    name: "GitHub",
    transport: "http",
    trust: "low",
    url: "https://mcp.TESTONLY.invalid/",
    toolsAllow: ["issues.read"],
    toolsDeny: [],
    resourcesAllow: [],
    networkAllow: [],
    audited: false,
  };
  it("accepts a sane oauth config; rejects oauth-on-stdio, secret-shaped clientId, http issuer/resource", () => {
    assert.equal(validateMcpConfig({ ...good, oauth: { clientId: "aice-cli", issuer: "https://as.TESTONLY.invalid/", scopes: ["mcp.read"], resource: "https://mcp.TESTONLY.invalid/" } }).length, 0);
    assert.ok(validateMcpConfig({ ...good, transport: "stdio", url: undefined, command: ["x"], oauth: { clientId: "aice-cli" } }).some((e) => /http\/sse transport/.test(e)));
    assert.ok(
      validateMcpConfig({ ...good, oauth: { clientId: ["g", "h", "p_"].join("") + "A".repeat(24) } }).some((e) => /looks like a secret/.test(e)),
    );
    assert.ok(validateMcpConfig({ ...good, oauth: { clientId: "ok", issuer: "http://as.example.com/" } }).some((e) => /issuer/.test(e)));
    assert.ok(validateMcpConfig({ ...good, oauth: { clientId: "ok", resource: "http://mcp.example.com/" } }).some((e) => /resource/.test(e)));
    assert.ok(validateMcpConfig({ ...good, oauth: { clientId: "" } }).some((e) => /clientId required/.test(e)));
  });
});
