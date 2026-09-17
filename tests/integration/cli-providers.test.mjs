// Integration: `aice` provider/model/budget surface over a REAL loopback provider
// (no external services). Key material flows via stdin into the detected vault;
// output assertions prove no secret value is ever echoed.
// NOTE: the mock server lives in THIS process, so the CLI must be spawned ASYNC
// (spawnSync would block this event loop and the mock would never answer).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = join(root, "apps", "cli", "src", "cli.ts");
const KEY = "sk-TESTONLY-cli-integration-42";
const LAST4 = "n-42"; // trailing four chars of KEY

let dir;
let dbPath;
let server;
let port;
let state;

function cli(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args, "--db", dbPath], {
      env: { ...process.env, DB_PATH: dbPath, XDG_CONFIG_HOME: join(dir, "cfg") },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", reject);
    child.on("close", (code) => resolve({ status: code, stdout, stderr }));
    if (opts.stdin !== undefined) child.stdin.write(opts.stdin);
    child.stdin.end();
  });
}

async function cliOk(args, opts = {}) {
  const r = await cli(args, opts);
  assert.equal(r.status, 0, `expected success: ${args.join(" ")}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  return r;
}

describe("CLI provider framework (loopback provider + encrypted vault)", () => {
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "aice-pcli-"));
    dbPath = join(dir, "app.db");
    state = { handler: () => ({ status: 200, body: { data: [] } }), seen: [] };
    server = createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        state.seen.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
        const out = state.handler(req);
        res.writeHead(out.status ?? 200, { "content-type": "application/json" });
        res.end(JSON.stringify(out.body));
      });
    });
    await new Promise((resolve) =>
      server.listen(0, "127.0.0.1", () => {
        port = server.address().port;
        resolve();
      }),
    );
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });

  it("provider add validates egress up front", async () => {
    const bad = await cli(["provider", "add", "--name", "evil", "--protocol", "openai-chat", "--base-url", "http://api.openai.com/v1"]);
    assert.equal(bad.status, 2); // usage-layer denial
    assert.match(bad.stderr, /EGRESS_DENIED|https/);
    const denyPrivate = await cli(["provider", "add", "--name", "evil2", "--protocol", "openai-chat", "--base-url", "https://192.168.5.5/v1"]);
    assert.equal(denyPrivate.status, 2);
  });

  it("provider key set demands --stdin (never argv)", async () => {
    const r = await cliOk(["provider", "add", "--name", "local", "--protocol", "local-openai-compatible", "--base-url", `http://127.0.0.1:${port}/v1`]);
    const id = r.stdout.match(/provider (\S+)/)[1];
    const noflag = await cli(["provider", "key", "set", id]);
    assert.equal(noflag.status, 2);
    assert.match(noflag.stderr, /stdin/);
    const withvalue = await cli(["provider", "key", "set", id, "--stdin", "--value", KEY], { stdin: KEY });
    assert.equal(withvalue.status, 2);
    assert.match(withvalue.stderr, /argv/);
  });

  it("key set (stdin) → vault file written, last4 in DB, value never echoed", async () => {
    const pid = JSON.parse((await cliOk(["provider", "list", "--json"])).stdout)[0].id;
    const set = await cliOk(["provider", "key", "set", pid, "--stdin"], { stdin: `${KEY}\n` });
    assert.ok(!set.stdout.includes(KEY), "key value must not be echoed");
    assert.match(set.stdout, new RegExp(`last4: ${LAST4}`));
    const status = await cliOk(["provider", "key", "status", pid]);
    assert.match(status.stdout, new RegExp(`last4 ${LAST4}`));
    const vaultFile = join(dir, "cfg", "aice", "vault.enc.json");
    const raw = readFileSync(vaultFile, "utf8");
    assert.ok(!raw.includes(KEY), "vault file must be ciphertext-only");
  });

  it("provider test + discover + probe over the mock, statuses persisted", async () => {
    const pid = JSON.parse((await cliOk(["provider", "list", "--json"])).stdout)[0].id;
    state.handler = (req) =>
      req.url.includes("chat")
        ? { status: 200, body: { model: "q4", choices: [{ message: { content: "pong" }, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 1 } } }
        : { status: 200, body: { data: [{ id: "q4" }, { id: "q5" }] } };
    const test = await cliOk(["provider", "test", pid]);
    assert.match(test.stdout, /OK \(2 models/);
    const discover = await cliOk(["model", "discover", pid]);
    assert.match(discover.stdout, /2 found \(2 added, 0 updated\)/);
    const list = JSON.parse((await cliOk(["model", "list", "--provider", pid, "--json"])).stdout);
    assert.deepEqual(
      list.map((m) => m.id),
      [`${pid}:q4`, `${pid}:q5`],
    );
    const probe = await cliOk(["model", "probe", "--provider", pid]);
    assert.match(probe.stdout, /PASS/);
    const afterProbe = JSON.parse((await cliOk(["model", "list", "--provider", pid, "--json"])).stdout);
    assert.ok(afterProbe.every((m) => m.status === "available" && m.verified === true));
    // auth header reached the mock from the vault
    const chatCall = state.seen.find((c) => c.url.includes("chat"));
    assert.equal(chatCall.headers.authorization, `Bearer ${KEY}`);
  });

  it("usage-based budget hard-blocks further probes", async () => {
    const pid = JSON.parse((await cliOk(["provider", "list", "--json"])).stdout)[0].id;
    // prior probes consumed 4 in-tokens per call across two models (q4, q5) = 8 total
    await cliOk(["budget", "set", "--provider", pid, "--window", "total", "--in", "8"]);
    const rl = await cli(["model", "probe", "--provider", pid]);
    assert.equal(rl.status, 1);
    assert.match(rl.stdout + rl.stderr + "", /FAIL/);
    const events = JSON.parse((await cliOk(["budget", "events", "--provider", pid, "--json"])).stdout);
    assert.ok(events.some((e) => e.decision === "blocked"), "blocked event recorded");
    assert.ok(events.some((e) => e.decision === "allowed"), "allowed usage events recorded");
  });

  it("key and probe content never leak into CLI output", async () => {
    const pid = JSON.parse((await cliOk(["provider", "list", "--json"])).stdout)[0].id;
    const events = (await cliOk(["budget", "events", "--limit", "50", "--json"])).stdout;
    assert.ok(!events.includes(KEY));
    const keyOut = (await cliOk(["provider", "key", "status", pid])).stdout;
    assert.ok(!keyOut.includes(KEY));
  });

  it("provider test failure exits 1 with redacted detail", async () => {
    state.handler = () => ({ status: 500, body: `crash: ${KEY}` });
    const pid = JSON.parse((await cliOk(["provider", "list", "--json"])).stdout)[0].id;
    const r = await cli(["provider", "test", pid]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /FAIL/);
    assert.ok(!r.stdout.includes(KEY), "provider body must be redacted in failures");
    assert.match(r.stdout, /REDACTED/);
  });
});
