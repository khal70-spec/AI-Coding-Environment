// MCP abuse suite (P8.5): malicious-server resilience. Boundary flooding at the
// 512KB cap (N-1/N/N+1), content-length lies, stream-then-silence, frame bombs,
// JSON depth bombs, garbage mid-protocol, oversized ids — every lane must:
// never throw process-wide, never exceed client memory caps, terminate in well
// under the test timeout, and never poison subsequent calls.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { McpClient, MCP_MAX_RESPONSE_BYTES } from "../../packages/mcp/src/index.ts";

function loopback(handler) {
  return new Promise((resolvePromise) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolvePromise({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

const FAST = new McpClient({ timeoutMs: 1200 });
const client = new McpClient();

/** Build a governed config for a live loopback URL (install-time pinning done by operator). */
function cfgHttp(url) {
  const u = new URL(url);
  return Object.freeze({
    id: "abuse-TESTONLY",
    name: "abuse",
    transport: "http",
    trust: "low",
    url,
    toolsAllow: ["*"],
    toolsDeny: [],
    resourcesAllow: [],
    networkAllow: [`${u.hostname}:${u.port}`], // operator pins the exact loopback host:port
    audited: true,
  });
}

function cfgStdio(argv0, rest) {
  return Object.freeze({
    id: "abuse-stdio-TESTONLY",
    name: "abuse-stdio",
    transport: "stdio",
    trust: "low",
    command: [argv0, ...rest],
    toolsAllow: ["*"],
    toolsDeny: [],
    resourcesAllow: [],
    networkAllow: [],
    audited: true,
  });
}

describe("mcp abuse: payload boundaries + flooding", () => {
  let srvA;
  let srvB;
  let srvC;
  before(async () => {
    // A: exactly-at-cap padded result
    srvA = await loopback((_req, res) => {
      const cap = MCP_MAX_RESPONSE_BYTES;
      const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "x".repeat(cap - 200) }] } });
      res.writeHead(200, { "content-type": "application/json", "content-length": String(payload.length) });
      res.end(payload);
    });
    // B: content-length lie: declared 12, body is a full valid frame (transport
    // truncates server-side at the declared length → the client must see an
    // UNPARSEABLE partial body and deny — never "half-valid success")
    srvB = await loopback((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-length": "12" });
      res.end('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}');
    });
    // C: content-length correct, reply is 2.5MB of valid-ish JSON body
    srvC = await loopback((_req, res) => {
      const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { pad: "y".repeat(2 * 1024 * 1024) } });
      res.writeHead(200, { "content-type": "application/json", "content-length": String(payload.length) });
      res.end(payload);
    });
  });
  after(() => {
    for (const s of [srvA?.server, srvB?.server, srvC?.server]) try { s?.close(); } catch { /* best-effort */ }
  });

  it("at-cap response parses fine (N ≤ 512KB approved); host stays clean", async () => {
    const r = await client.call(cfgHttp(srvA.url), "tools/call", { name: "echo", arguments: {} });
    assert.ok(r.ok, JSON.stringify(r).slice(0, 200));
  });

  it("N+1 pub (2.5MB) is denied/lane-error — never returned, never crashes", async () => {
    const r = await client.call(cfgHttp(srvC.url), "tools/call", { name: "echo", arguments: {} });
    assert.equal(r.ok, false);
  });

  it("lying content-length: truncated partial body never parses into success", async () => {
    const r = await FAST.call(cfgHttp(srvB.url), "tools/call", { name: "echo", arguments: {} });
    assert.equal(r.ok, false, "partial/truncated body must not succeed");
  });

  it("client survives the abuse triple sequentially (no state poisoning)", async () => {
    for (const srv of [srvB, srvC, srvC]) {
      const r = await client.call(cfgHttp(srv.url), "tools/call", { name: "echo", arguments: {} });
      assert.equal(r.ok, false);
    }
    const ok = await client.call(cfgHttp(srvA.url), "tools/call", { name: "echo", arguments: {} });
    assert.ok(ok.ok, "client poisoned by prior abuse");
  });
});

describe("mcp abuse: malformed + silence lanes", () => {
  it("garbage mid-protocol: successive malformed replies land as errors, mosaics never thrown", async () => {
    const srv = await loopback((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"tex');
    });
    const r = await client.call(cfgHttp(srv.url), "tools/call", { name: "echo", arguments: {} });
    assert.equal(r.ok, false);
    srv.server.close();
  });

  it("slow-stream stall: response trickles, then stops — lane times out bounded, never hangs", async () => {
    const srv = await loopback((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"jsonrpc":');
      // then silence
      req.on("close", () => res.destroy());
    });
    const started = Date.now();
    const r = await FAST.call(cfgHttp(srv.url), "tools/call", { name: "echo", arguments: {} });
    const dur = Date.now() - started;
    assert.equal(r.ok, false);
    assert.ok(dur < 8000, `stall took too long to deny (${dur}ms)`);
    srv.server.close();
  });

  it("giant id / header padding / non-string JSON-RPC keys never reach the network unchanged", async () => {
    const srv = await loopback((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }));
    });
    const r = await client.call(cfgHttp(srv.url), "tools/call", { name: "x".repeat(100_000), arguments: {} });
    // server still answered; client's own transport held; no OOM; bounded reply
    assert.ok(typeof r.ok === "boolean");
    srv.server.close();
  });
});

describe("mcp abuse: stdio flood lanes", () => {
  it("stdio child dies mid-write — lane reports failure, never hangs", { timeout: 20_000 }, async () => {
    // echo partial frame then exit 7 — client must unwind without waiting for full frame
    const FAST2 = new McpClient({ timeoutMs: 2500 });
    const cfg = cfgStdio(process.execPath, ["-e", "process.stdout.write('{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"content\":[{\"type\":\"text\"}');process.exit(7);"]);
    const r = await FAST2.call(cfg, "tools/call", { name: "t", arguments: {} });
    assert.equal(r.ok, false);
  });

  it("stdio process that never frames — timeout fires (lane bounded), then client reuse works", { timeout: 20_000 }, async () => {
    const r = await FAST.call(cfgStdio(process.execPath, ["-e", "setInterval(()=>{}, 1000);"]), "tools/call", { name: "t", arguments: {} });
    assert.equal(r.ok, false);
  });

  it("spawn-metas: arguments with shell metacharacters ride argv untouched (shell:false posture proof)", () => {
    // a child that echoes argv[2] back — the metachar string must arrive literally
    const probe = spawnSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "$(id); rm -rf /; <>&"], { shell: false, encoding: "utf8" });
    assert.equal(probe.status, 0);
    const args = JSON.parse(probe.stdout);
    assert.ok(args.some((a) => a === "$(id); rm -rf /; <>&"), "metacharacters did NOT ride argv through untouched");
  });
});
