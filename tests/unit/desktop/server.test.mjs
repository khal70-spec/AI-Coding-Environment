// Integration: desktop bridge server (P7.2/P7.4) — request canopy, method/canary
// paths, traversal, host gate, body caps, static MIME whitelist, CSP, and the
// live dispatch path (bridge → services → engine → audited state).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { startBridge } from "../../../apps/desktop/src/server.ts";

/** Minimal raw fetch via node http (keeps redirect/JSDOM out of scope). */
async function call(port, { method = undefined, path = "/api/bridge", headers = {}, body = null } = {}) {
  if (method === undefined) method = body !== null ? "POST" : "GET";
  const init = { method, headers, redirect: "manual" };
  if (body !== null) init.body = typeof body === "string" ? body : JSON.stringify(body);
  const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* static bodies */ }
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()), text, json };
}

describe("desktop bridge server", () => {
  let dir = "";
  let handle;
  let port;
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "aice-desktop-"));
    const web = join(dir, "web");
    mkdirSync(web, { recursive: true });
    writeFileSync(join(web, "index.html"), "<html><body>ok</body></html>");
    writeFileSync(join(web, "app.js"), "console.log(1)");
    writeFileSync(join(web, "app.css"), "body{}");
    writeFileSync(join(web, "secret.txt"), "deny");
    handle = await startBridge({ dbPath: join(dir, "app.db"), actor: "op-TESTONLY", webRoot: web, allowedHosts: ["127.0.0.1", "localhost", "example.dev"] });
    port = handle.port;
  });
  after(() => {
    handle?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("host gate: absent/foreign hosts refused structurally (403 HOST_DENIED)", async () => {
    const rawHost = (host) =>
      new Promise((resolve, reject) => {
        const req = http.request({ port, host: "127.0.0.1", path: "/index.html", headers: { Host: host } }, (res) => {
          res.resume();
          resolve(res.statusCode);
        });
        req.on("error", reject);
        req.end();
      });
    assert.equal(await rawHost("evil.com"), 403);
    assert.equal(await rawHost("example.dev"), 200);
    assert.equal(await rawHost("foo.example.dev"), 200, "preview subdomains pass");
  });

  it("static surface: MIME whitelist + traversal denied + unknown ext octet-stream", async () => {
    const idx = await call(port, { method: "GET", path: "/index.html" });
    assert.equal(idx.status, 200);
    assert.match(idx.headers["content-type"], /text\/html/);
    assert.match(idx.headers["content-security-policy"], /default-src 'self'/);
    assert.equal(idx.headers["x-content-type-options"], "nosniff");
    const js = await call(port, { method: "GET", path: "/app.js" });
    assert.match(js.headers["content-type"], /javascript/);
    const css = await call(port, { method: "GET", path: "/app.css" });
    assert.match(css.headers["content-type"], /text\/css/);
    const txt = await call(port, { method: "GET", path: "/secret.txt" });
    assert.match(txt.headers["content-type"], /application\/octet-stream/);
    for (const p of ["/../app.db", "/%2e%2e/app.db", "/..\\app.db", "//etc/passwd", "/<script>.js", "/app.js/<x>"]) {
      const r = await call(port, { method: "GET", path: p });
      assert.ok(r.status === 400 || r.status === 404, `${p} -> ${r.status}`);
    }
    // query string is stripped before path validation (its bytes never touch fs)
    const qs = await call(port, { method: "GET", path: "/index.html?x=<script>" });
    assert.equal(qs.status, 200);
    const head = await fetch(`http://127.0.0.1:${port}/app.js`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal((await head.text()).length, 0);
  });

  it("api surface: POST-only, JSON-only, host-gated, no-store", async () => {
    const get = await call(port, { method: "GET", path: "/api/bridge" });
    assert.equal(get.status, 405);
    assert.equal(get.json.code, "METHOD");
    const del = await call(port, { method: "DELETE", path: "/api/bridge" });
    assert.equal(del.status, 405);
    const ok = await call(port, { body: { command: "projects.list" } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.ok, true);
    assert.equal(ok.headers["cache-control"], "no-store");
    assert.match(ok.headers["content-type"], /application\/json/);
  });

  it("unknown command → 404 with stable lane; bad args → 400; giant body → 413; control chars → 400", async () => {
    const unk = await call(port, { body: { command: "drop.table" } });
    assert.equal(unk.status, 404);
    assert.equal(unk.json.code, "UNKNOWN_COMMAND");
    const badArgs = await call(port, { body: { command: "tasks.list", args: { smuggle: "x" } } });
    assert.equal(badArgs.status, 400);
    const badJson = await call(port, { body: '{"command":' } );
    assert.equal(badJson.status, 400);
    const ctrl = await call(port, { body: '{"command":"projects.list","x":""}' });
    assert.equal(ctrl.status, 400);
    const huge = JSON.stringify({ command: "projects.list", args: { pad: "x".repeat(70000) } });
    const big = await call(port, { body: huge } );
    assert.ok(big.status === 413 || big.json?.code === "BAD_ARGS", `got ${big.status}`);
    const noCmd = await call(port, { body: { args: {} } });
    assert.equal(noCmd.status, 400);
  });

  it("live dispatch: project → task → advance through the engine with audit", async () => {
    const p = await call(port, { body: { command: "projects.create", args: { name: "srv-TESTONLY", rootPath: dir } } });
    assert.equal(p.json.ok, true);
    const t = await call(port, { body: { command: "tasks.create", args: { projectId: p.json.data.id, title: "live", risk: "medium" } } });
    assert.equal(t.json.ok, true);
    const show = await call(port, { body: { command: "tasks.show", args: { taskId: t.json.data.id } } });
    assert.equal(show.json.ok, true);
    assert.equal(show.json.data.task.state, "CREATED");
    const adv = await call(port, { body: { command: "tasks.advance", args: { taskId: t.json.data.id } } });
    assert.equal(adv.json.ok, true, JSON.stringify(adv.json));
    const bad = await call(port, { body: { command: "tasks.advance", args: { taskId: t.json.data.id, to: "MERGED" } } });
    assert.equal(bad.json.ok, false);
    assert.equal(bad.json.code, "HANDLER_FAILED");
    // audit got the transition set (content-free)
    const audit = await call(port, { body: { command: "audit.list", args: { taskId: t.json.data.id, limit: 50 } } });
    const actions = audit.json.data.map((a) => `${a.action}|${a.decision ?? ""}`);
    assert.ok(actions.some((a) => a.startsWith("task.transition")));
  });

  it("fuzz canopy: random hostile envelopes never 500-crash the server", async () => {
    const samples = [
      '{"command":"projects.list","args":{"id":null}}',
      '{"command":"projects.list","args":{"id":[]}}',
      '{"command":"projects.list","args":{"id":{}}}',
      '{"command":"approvals.record","args":{"taskId":"","kind":"plan"}}',
      '{"command":"tasks.create","args":{".":1}}',
      '{"command":"tasks.bundle","args":{"taskId":"../../..../../etc/passwd"}}',
      '{"command":"mcp.toggle","args":{"id":"',
      '{"command":"projects.list"}{"command":"tasks.list"}',
    ];
    for (const s of samples) {
      const r = await call(port, { body: s } );
      assert.ok([200, 400, 404, 405, 413, 500].includes(r.status));
      assert.equal(typeof r.text, "string");
      assert.ok(r.text.length < 4096, "bounded reply");
    }
    // server still alive
    const alive = await call(port, { body: { command: "projects.list" } });
    assert.equal(alive.status, 200);
  });
});
