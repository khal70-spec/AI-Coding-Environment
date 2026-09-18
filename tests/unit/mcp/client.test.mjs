// Unit: MCP client containment (P6.2) — real JSON-RPC over loopback http + stdio
// children, plus the hostile scenarios: oversized answers, redirects, dead servers,
// hostile exit codes. Zero network beyond the loopback harness.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpClient, MCP_DEFAULT_TIMEOUT_MS } from "../../../packages/mcp/src/client.ts";
import { decideMcpCall } from "../../../packages/mcp/src/gates.ts";

const OPENED = [];

function loopbackServer(handler) {
  return new Promise((resolve) => {
    const srv = createServer(handler);
    srv.listen(0, "127.0.0.1", () => {
      const handle = { server: srv, url: `http://127.0.0.1:${srv.address().port}` };
      OPENED.push(srv);
      resolve(handle);
    });
  });
}

after(() => {
  for (const s of OPENED) {
    s.closeAllConnections();
    s.close();
  }
});

const BASE_STDIO_CFG = {
  id: "echo-TESTONLY",
  name: "echo server",
  transport: "stdio",
  trust: "low",
  command: [process.execPath],
  toolsAllow: ["echo"],
  toolsDeny: [],
  resourcesAllow: [],
  networkAllow: [],
  audited: false,
};

function goodReply(msg) {
  return { jsonrpc: "2.0", id: msg.id, result: { echoed: msg.method } };
}

describe("http transport containment", () => {
  it("happy path: loopback http server gets the RPC and answers", async () => {
    const received = [];
    const srv = await loopbackServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push(body);
        const msg = JSON.parse(body);
        res.setHeader("content-type", "application/json");
        res.setHeader("connection", "close");
        res.end(JSON.stringify(goodReply(msg)));
      });
    });
    const cfg = {
      id: "echo-http",
      name: "echo http",
      transport: "http",
      trust: "low",
      url: `${srv.url}/rpc`,
      toolsAllow: ["echo"],
      toolsDeny: [],
      resourcesAllow: [],
      networkAllow: [`127.0.0.1:${srv.server.address().port}`],
      audited: false,
    };
    const gate = decideMcpCall({ server: cfg, enabled: true, tool: "echo" });
    assert.equal(gate.allowed, true, gate.reason);
    const client = new McpClient({});
    const res = await client.call(cfg, "echo", { text: "fixture-marker-TESTONLY" });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.result.echoed, "echo");
    assert.match(received[0], /fixture-marker-TESTONLY/);
  });

  it("oversized answer → cap lane, never surfaces content", async () => {
    const srv = await loopbackServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.setHeader("connection", "close");
      const big = JSON.stringify({ jsonrpc: "2.0", id: "x", result: { blob: "A".repeat(1024 * 1024) } });
      res.end(big);
    });
    const cfg = {
      id: "big-TESTONLY",
      name: "big",
      transport: "http",
      trust: "low",
      url: `${srv.url}/rpc`,
      toolsAllow: ["echo"],
      toolsDeny: [],
      resourcesAllow: [],
      networkAllow: [`127.0.0.1:${srv.server.address().port}`],
      audited: false,
    };
    const res = await new McpClient({}).call(cfg, "echo");
    assert.equal(res.ok, false);
    assert.match(res.error, /byte cap/);
  });

  it("dead server → error lane only (no stack, no content)", async () => {
    const srv = await loopbackServer((_req, _res) => {});
    const port = srv.server.address().port;
    srv.server.close();
    const cfg = {
      id: "dead-TESTONLY",
      name: "dead",
      transport: "http",
      trust: "low",
      url: `http://127.0.0.1:${port}/rpc`,
      toolsAllow: ["echo"],
      toolsDeny: [],
      resourcesAllow: [],
      networkAllow: [`127.0.0.1:${port}`],
      audited: false,
    };
    const res = await new McpClient({ timeoutMs: 2000 }).call(cfg, "ping");
    assert.equal(res.ok, false);
    assert.match(res.error, /transport error|timeout/);
    assert.match(res.error, /fetch failed|ECONNREFUSED|connect/);
    assert.doesNotMatch(res.error, /127\.0\.0\.1/, "no endpoint leak in error text");
  }, 10_000);

  it("non-JSON frame → refused (malformed is not a result)", async () => {
    const srv = await loopbackServer((_req, res) => {
      res.setHeader("connection", "close");
      res.end("<html><body>not json-rpc</body></html>");
    });
    const cfg = {
      id: "junk-TESTONLY",
      name: "junk",
      transport: "http",
      trust: "low",
      url: `${srv.url}/rpc`,
      toolsAllow: ["echo"],
      toolsDeny: [],
      resourcesAllow: [],
      networkAllow: [`127.0.0.1:${srv.server.address().port}`],
      audited: false,
    };
    const res = await new McpClient({}).call(cfg, "echo");
    assert.equal(res.ok, false);
    assert.match(res.error, /not JSON-RPC/);
  });
});

describe("stdio transport containment", () => {
  it("argv-only child; one JSON line in → one JSON line out", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aice-mcp-child-"));
    const childPath = join(dir, "echo-server.js");
    writeFileSync(
      childPath,
      "let buf='';process.stdin.on('data',c=>buf+=c).on('end',()=>{const m=JSON.parse(buf.trim());process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{echoed:m.method}})+'\\n');});",
    );
    const cfg = { ...BASE_STDIO_CFG, command: [process.execPath, childPath] };
    const res = await new McpClient({}).call(cfg, "echo");
    assert.equal(res.ok, true, res.error);
    assert.equal(res.result.echoed, "echo");
    rmSync(dir, { recursive: true, force: true });
  });

  it("hostile child exits instantly → structured error, no crash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aice-mcp-dead-"));
    const p = join(dir, "dies.js");
    writeFileSync(p, "process.exit(42);");
    const cfg = { ...BASE_STDIO_CFG, command: [process.execPath, p] };
    const res = await new McpClient({}).call(cfg, "echo", undefined);
    assert.equal(res.ok, false);
    assert.match(res.error, /exited|spawn/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("shell metacharacters in argv stay inert (no exec semantics)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aice-mcp-inert-"));
    const p = join(dir, "print-args.js");
    writeFileSync(p, "process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:'x',result:{argv:process.argv.slice(2)}})+'\\n');");
    const evil = "; touch /tmp/pwn-TESTONLY-`whoami`.txt";
    const res = await new McpClient({}).call({ ...BASE_STDIO_CFG, command: [process.execPath, p, evil] }, "ping");
    assert.equal(res.ok, true, res.error);
    assert.ok(res.result.argv.includes(evil), "metacharacters are pure DATA to the child");
    rmSync(dir, { recursive: true, force: true });
  }, 15_000);

  it("MCP client enforces the endpoint gate itself (defense in depth)", async () => {
    const bad = { ...BASE_STDIO_CFG, transport: "http", url: "https://api.external.test/rpc", toolsAllow: ["echo"], networkAllow: ["other.external.test:443"] };
    const res = await new McpClient({}).call(bad, "echo");
    assert.equal(res.ok, false);
    assert.equal(res.lane, "denied");
    assert.match(res.error, /egress/);
  });

  it("timeouts are enforced", async () => {
    const srv = await loopbackServer((_req, _res) => {
      /* never respond */
    });
    const cfg = {
      id: "silent-TESTONLY",
      name: "silent",
      transport: "http",
      trust: "low",
      url: `${srv.url}/rpc`,
      toolsAllow: ["echo"],
      toolsDeny: [],
      resourcesAllow: [],
      networkAllow: [`127.0.0.1:${srv.server.address().port}`],
      audited: false,
    };
    const t0 = Date.now();
    const res = await new McpClient({ timeoutMs: 250 }).call(cfg, "echo");
    assert.equal(res.ok, false);
    assert.match(res.error, /timeout/);
    assert.ok(Date.now() - t0 < MCP_DEFAULT_TIMEOUT_MS, "timeout aborted promptly");
    srv.server.closeAllConnections();
    srv.server.close();
  }, 15_000);
});
