// Unit: provider transport — egress policy + fetch behavior over a REAL loopback
// server (no external services). Failure shapes must map to the stable taxonomy,
// response caps and timeouts must hold, and provider bodies must be redacted in errors.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  assertProviderEndpoint,
  fetchTransport,
  ProviderError,
  urlFor,
  DEFAULT_MAX_RESPONSE_BYTES,
} from "../../../packages/providers/src/index.ts";

function startEcho(handler) {
  const seen = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      const out = handler(req, seen.at(-1).body);
      res.writeHead(out.status ?? 200, { "content-type": "application/json" });
      res.end(typeof out.body === "string" ? out.body : JSON.stringify(out.body));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        port: server.address().port,
        seen,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

async function expectCode(promise, code) {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof ProviderError, `expected ProviderError, got ${String(err)}`);
    assert.equal(err.code, code, err.message);
    return err;
  }
  assert.fail(`expected ProviderError ${code}, request succeeded`);
}

describe("provider egress policy", () => {
  it("accepts https remote endpoints and loopback local endpoints", () => {
    assert.ok(assertProviderEndpoint("https://api.openai.com/v1", "openai-chat"));
    assert.ok(assertProviderEndpoint("http://127.0.0.1:1234/v1", "local-openai-compatible"));
    assert.ok(assertProviderEndpoint("https://localhost:8443/v1", "local-openai-compatible"));
  });

  it("denies http for remote protocols", async () => {
    await expectCode(
      Promise.resolve().then(() => assertProviderEndpoint("http://api.openai.com/v1", "openai-chat")),
      "EGRESS_DENIED",
    );
  });

  it("denies loopback targets for remote protocols", async () => {
    await expectCode(
      Promise.resolve().then(() => assertProviderEndpoint("http://127.0.0.1:1234", "openai-chat")),
      "EGRESS_DENIED",
    );
  });

  it("denies private/metadata hosts and credentialed URLs for remote protocols", async () => {
    for (const bad of [
      "https://169.254.169.254/latest",
      "https://192.168.1.10:11434/v1",
      "https://10.0.0.5/v1",
      "https://user:pass@api.openai.com/v1",
      "ftp://api.openai.com/v1",
      "not a url",
    ]) {
      await expectCode(
        Promise.resolve().then(() => assertProviderEndpoint(bad, "openai-chat")),
        "EGRESS_DENIED",
      );
    }
  });

  it("urlFor pins adapters to same-origin relative joins", async () => {
    assert.equal(urlFor("https://x.test/v1/", "/chat/completions"), "https://x.test/v1/chat/completions");
    await expectCode(
      Promise.resolve().then(() => urlFor("https://x.test/v1", "https://evil.example/x")),
      "EGRESS_DENIED",
    );
  });
});

describe("provider transport (loopback)", () => {
  let mock;
  let handler;
  before(async () => {
    handler = () => ({ status: 200, body: { ok: true } });
    mock = await startEcho((req, body) => handler(req, body));
  });
  after(async () => mock.close());

  const baseReq = () => ({
    method: "POST",
    url: `${mock.url}/v1/chat/completions`,
    headers: { "content-type": "application/json" },
    timeoutMs: 5_000,
    maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
  });

  it("round-trips a 2xx JSON body", async () => {
    handler = () => ({ status: 200, body: { hello: "world" } });
    const res = await fetchTransport()(baseReq());
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { hello: "world" });
  });

  it("maps 401/403 to AUTH", async () => {
    handler = () => ({ status: 401, body: { error: "bad key" } });
    await expectCode(fetchTransport()(baseReq()), "AUTH");
  });

  it("maps 429 to RATE_LIMIT with retry hint", async () => {
    handler = () => ({ status: 429, body: "slow down" });
    const err = await expectCode(fetchTransport()(baseReq()), "RATE_LIMIT");
    assert.ok(err.transient);
  });

  it("maps 5xx to SERVER and redacts secret-looking response bodies", async () => {
    const leaked = "sk-EXAMPLE1234567890abcdefEXAMPLE1234567890abcdef";
    handler = () => ({ status: 500, body: { error: `oops ${leaked}` } });
    const err = await expectCode(fetchTransport()(baseReq()), "SERVER");
    assert.ok(!err.message.includes(leaked), "raw key must never appear in error text");
    assert.match(err.message, /\[REDACTED:openai\]/);
  });

  it("maps 400 context-length wording to CONTEXT_LENGTH, else VALIDATION", async () => {
    handler = () => ({ status: 400, body: "context_length_exceeded: too many tokens" });
    await expectCode(fetchTransport()(baseReq()), "CONTEXT_LENGTH");
    handler = () => ({ status: 400, body: { error: "unknown field" } });
    await expectCode(fetchTransport()(baseReq()), "VALIDATION");
  });

  it("enforces the response byte cap", async () => {
    handler = () => ({ status: 200, body: "x".repeat(10_000) });
    await expectCode(
      fetchTransport()({ ...baseReq(), maxResponseBytes: 1_000 }),
      "SERVER",
    );
  });

  it("maps connect failures to NETWORK (dead port)", async () => {
    // Reserve a port we know is closed: bind then close.
    const dead = await startEcho(() => ({ status: 200, body: "unused" }));
    await dead.close();
    await expectCode(
      fetchTransport()({ ...baseReq(), url: `${dead.url}/x`, timeoutMs: 1_000 }),
      "NETWORK",
    );
  });

  it("surfaces malformed JSON as SERVER at the adapter layer (transport returns raw body)", async () => {
    handler = () => ({ status: 200, body: "<html>proxy error</html>" });
    const res = await fetchTransport()(baseReq());
    assert.equal(res.body, "<html>proxy error</html>"); // adapter's parseProviderJson classifies
  });
});
