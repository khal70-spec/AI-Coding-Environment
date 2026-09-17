// Unit: browser.fetch stub — egress gate, policy allowlist, caps, no-JS extraction (P3.4).
// The server lives in the test process; the tool fetches in-process — no spawnSync deadlock
// risk applies (that rule is about subprocesses).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRunner } from "../../../packages/tools/src/runtime.ts";
import { BROWSER_TOOLS, htmlToText, isPrivateOrMetadataHost } from "../../../packages/tools/src/browser-tool.ts";

const FAKE_GH = ["g", "h", "p_"].join("") + "C".repeat(24) + "-TESTONLY";

function untag(output) {
  const lines = output.split("\n");
  assert.ok(lines[0].startsWith("<<<UNTRUSTED-TOOL-OUTPUT"));
  assert.equal(lines[lines.length - 1], "<<<END-UNTRUSTED-TOOL-OUTPUT>>>");
  return lines.slice(1, -1).join("\n");
}

const mkGrant = (networkAllow = [], networkDefault = "deny") => ({
  toolsAllow: ["browser.fetch"],
  toolsDeny: [],
  fsRead: "workspace",
  fsWrite: "workspace",
  terminal: "none",
  networkDefault,
  networkAllow,
  maxRisk: "high",
  maxClassification: "confidential",
});
const PCTX = { workspaceLocked: false, providerMaxClassification: "confidential" };

let server, baseUrl, hits;
before(async () => {
  hits = { total: 0 };
  server = createServer((req, res) => {
    hits.total += 1;
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "/nope" });
      res.end();
      return;
    }
    if (req.url === "/html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<html><head><style>body{color:red}</style></head><body><h1>Headline TESTONLY</h1><script>globalThis.pwned = true;</script><p>para &amp; one</p></body></html>");
      return;
    }
    if (req.url === "/secret") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`the token is ${FAKE_GH} keep it (TESTONLY body)`);
      return;
    }
    if (req.url === "/binary") {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(Buffer.from([1, 2, 3, 4]));
      return;
    }
    if (req.url === "/big") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("z".repeat(512 * 1024));
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("hello fetch TESTONLY");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (server) await new Promise((r) => server.close(r));
});

function setup(grant) {
  const root = mkdtempSync(join(tmpdir(), "aice-brow-"));
  const runner = new ToolRunner(BROWSER_TOOLS);
  const call = (args) =>
    runner.call(
      { tool: "browser.fetch", args, cwd: root, risk: "low", classification: "public" },
      {
        actor: "agent:tester", risk: "low", classification: "public",
        grant, policyCtx: PCTX, jailRoot: root,
      },
    );
  return { call, body: (r) => untag(r.output) };
}

describe("browser.fetch through ToolRunner", () => {
  it("allowlisted loopback (local regime): fetch succeeds, output tagged", async () => {
    const { call, body } = setup(mkGrant(["127.0.0.1"]));
    const res = await call({ url: `${baseUrl}/` });
    assert.equal(res.ok, true, body(res));
    const b = body(res);
    assert.match(b, /hello fetch TESTONLY/);
    assert.match(b, /browser\.fetch: 200/);
    assert.equal(res.data.status, 200);
  });

  it("non-allowlisted host: policy denies BEFORE the network is touched", async () => {
    const before2 = hits.total;
    const { call } = setup(mkGrant([])); // allowlist empty, default deny
    const res = await call({ url: `${baseUrl}/` });
    assert.equal(res.ok, false);
    assert.equal(res.code, "POLICY_DENIED");
    assert.equal(hits.total, before2, "server must not have been contacted");
  });

  it("loopback WITHOUT explicit allowlist entry: preflight hard-deny (neverAllow path)", async () => {
    const { call } = setup(mkGrant([], "allow")); // default-allow would otherwise accept
    const res = await call({ url: `${baseUrl}/` });
    assert.equal(res.ok, false);
    assert.equal(res.code, "POLICY_DENIED");
    assert.match(String(res.reasons), /never allowed/);
  });

  it("file:// and other schemes are never allowed", async () => {
    const { call } = setup(mkGrant([], "allow"));
    const res = await call({ url: "file:///etc/passwd" });
    assert.equal(res.code, "POLICY_DENIED");
  });

  it("credentials-in-URL refused", async () => {
    const { call } = setup(mkGrant(["127.0.0.1"], "deny"));
    const res = await call({ url: `${baseUrl}/`.replace("http://", "http://user:pw@") });
    assert.equal(res.code, "POLICY_DENIED");
  });

  it("redirects are not followed (EXECUTION_FAILED, redacted location)", async () => {
    const { call, body } = setup(mkGrant(["127.0.0.1"]));
    const res = await call({ url: `${baseUrl}/redirect` });
    assert.equal(res.ok, false);
    assert.equal(res.code, "EXECUTION_FAILED");
    assert.match(body(res), /redirect not followed/);
  });

  it("html bodies become text with scripts stripped (no JS execution)", async () => {
    const { call, body } = setup(mkGrant(["127.0.0.1"]));
    const res = await call({ url: `${baseUrl}/html` });
    assert.equal(res.ok, true, body(res));
    const b = body(res);
    assert.match(b, /Headline TESTONLY/);
    assert.match(b, /para & one/);
    assert.doesNotMatch(b, /script>globalThis/);
    assert.equal(globalThis.pwned, undefined, "no JS execution by construction");
  });

  it("secret-shaped responses are redacted + hit-kinds surfaced", async () => {
    const { call, body } = setup(mkGrant(["127.0.0.1"]));
    const res = await call({ url: `${baseUrl}/secret` });
    assert.equal(res.ok, true, body(res));
    assert.ok(!body(res).includes(FAKE_GH));
    assert.deepEqual(res.redactedKinds, ["github-token"]);
  });

  it("oversized bodies are capped", async () => {
    const { call, body } = setup(mkGrant(["127.0.0.1"]));
    const res = await call({ url: `${baseUrl}/big` });
    assert.equal(res.ok, true, body(res));
    assert.ok(Buffer.byteLength(untag(res.output), "utf8") < 300 * 1024);
    assert.match(body(res), /\[capped\]/);
  }, 20_000);

  it("non-text content-types are refused", async () => {
    const { call } = setup(mkGrant(["127.0.0.1"]));
    const res = await call({ url: `${baseUrl}/binary` });
    assert.equal(res.code, "EXECUTION_FAILED");
    assert.match(res.output, /content-type not allowed/);
  });

  it("public-host default-allow regime reaches the network layer (offline-safe failure)", async () => {
    const { call } = setup(mkGrant([], "allow"));
    const res = await call({ url: "http://example.invalid/" });
    assert.equal(res.code, "EXECUTION_FAILED");
    assert.match(res.output, /fetch failed|aborted/);
  }, 20_000);
});

describe("helpers (pure)", () => {
  it("isPrivateOrMetadataHost classifies RFC1918, loopback, metadata", () => {
    for (const h of ["127.0.0.1", "10.1.2.3", "192.168.1.9", "172.16.5.5", "169.254.1.1", "localhost", "metadata.google.internal", "[fd00::8]"]) {
      assert.equal(isPrivateOrMetadataHost(h), true, h);
    }
    assert.equal(isPrivateOrMetadataHost("8.8.8.8"), false);
    assert.equal(isPrivateOrMetadataHost("example.com"), false);
  });

  it("htmlToText handles nested scripts and entities", () => {
    const text = htmlToText("<p>a</p><script><b>not-code</b></script>&lt;t&gt;");
    assert.equal(text, "a <t>");
  });
});
