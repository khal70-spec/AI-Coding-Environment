// E2E: agent loop through the REAL ProviderDispatcher (real fetchTransport) against a
// REAL loopback OpenAI-compatible mock (local-openai-compatible egress is the only
// loopback exception, and this test uses exactly that lane). Proves:
//   - kernel transcript ↔ dispatcher round trips drive multi-turn tool use
//   - tool output really reached the provider on the wire (marker assert)
//   - dispatcher secret gate (T11) refuses a transport carrying token-looking content
//   - egress gate refuses non-loopback bases without touching the network
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderDispatcher } from "../../../packages/providers/src/dispatcher.ts";
import { ProviderError } from "../../../packages/providers/src/errors.ts";
import { ToolRunner } from "../../../packages/tools/src/runtime.ts";
import { FS_TOOLS } from "../../../packages/tools/src/fs-tools.ts";
import { investigate } from "../../../packages/agents/src/investigator.ts";

const posts = (opened) => opened.requests.filter((r) => r.url === "/chat/completions");

/** ProviderDispatcher-backed transport against a provider mock (real fetch, real gates). */
function makeTransport(opened) {
  const dispatcher = new ProviderDispatcher({});
  const config = {
    id: "mock-local",
    name: "mock",
    protocol: "local-openai-compatible",
    baseUrl: opened.url,
    maxClassification: "confidential",
  };
  return async (messages) => {
    const res = await dispatcher.complete(
      config,
      { model: "mock-test-model", messages: messages.map((m) => ({ role: m.role === "tool" ? "user" : m.role, content: m.content })) },
      { contextClassification: "internal" },
    );
    return { content: res.content };
  };
}

const SECRET_FILE_CONTENT = "token = ghp_TESTONLYabcdefghijklmnopqrstuv\n";

function mockProvider(answers) {
  const requests = [];
  const server = createServer((req, res) => {
    res.setHeader("connection", "close"); // undici keep-alive would hold the process open
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let parsed = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        /* keep empty */
      }
      requests.push({ url: req.url, body: parsed });
      if (req.method === "POST" && req.url === "/chat/completions") {
        const content = answers.length > 0 ? answers.shift() : "## Summary\nout of script";
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            model: "mock-test-model",
            choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
            usage: { prompt_tokens: 12, completion_tokens: 7 },
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const handle = { server, url: `http://127.0.0.1:${server.address().port}`, requests };
      openedServers.push(handle);
      resolve(handle);
    });
  });
}

const openedServers = [];

describe("agent loop × real dispatcher × loopback mock", () => {
  let root;
  before(async () => {
    root = mkdtempSync(join(tmpdir(), "aice-e2e-"));
    writeFileSync(join(root, "MARKER.txt"), "wire-marker-TESTONLY-9f7b\n");
  });
  after(() => {
    for (const h of openedServers) {
      h.server.closeAllConnections();
      h.server.close();
    }
  });

  it("investigate over real HTTP: tool output rides the wire to the mock; note returns", async () => {
    const answers = [
      'First, the file.\n```tool\n{"tool":"fs.read","args":{"path":"MARKER.txt"}}\n```',
      "## Summary\nfixture read.\n## Relevant code (file:line)\nMARKER.txt:1\n## Dependencies & entry points\nnone\n## Risks / security notes\nnone\n## Suggested verification (tests/scans)\nrun tests",
    ];
    const opened = await mockProvider(answers);
    const auditEvents = [];
    let serverHitsAfterGate = 0;
    const dispatcher = new ProviderDispatcher({
      audit: (e) => auditEvents.push(e),
      budget: { guard: () => {}, record: (r) => auditEvents.push({ kind: "budget.record", providerId: r.providerId, model: r.model, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens }) },
    });
    const config = {
      id: "mock-local",
      name: "mock",
      protocol: "local-openai-compatible",
      baseUrl: opened.url,
      maxClassification: "confidential",
    };
    const transport = async (messages) => {
      const res = await dispatcher.complete(
        config,
        {
          model: "mock-test-model",
          messages: messages.map((m) => ({
            role: m.role === "tool" ? "user" : m.role,
            content: m.content,
          })),
        },
        { contextClassification: "internal" },
      );
      return { content: res.content };
    };
    const res = await investigate(
      {
        runner: new ToolRunner(FS_TOOLS),
        jailRoot: root,
        policyCtx: { workspaceLocked: false, providerMaxClassification: "confidential" },
        transport,
        task: { title: "E2E wire-through" },
      },
      { maxIterations: 4 },
    );
    assert.equal(res.status, "completed");
    assert.match(res.note, /fixture read/);
    // TWO completion POSTs on the wire; the second must contain the untrusted tool
    // output marker — proof the fs.read result truly reached the provider.
    const posts = opened.requests.filter((r) => r.url === "/chat/completions");
    assert.equal(posts.length, 2, JSON.stringify(posts.map((p) => p.url)));
    const wireText = posts[1].body.messages.map((m) => m.content).join("\n");
    assert.match(wireText, /wire-marker-TESTONLY-9f7b/);
    assert.match(wireText, /UNTRUSTED-TOOL-OUTPUT tool="fs.read"/);
    assert.match(wireText, /trust-TAGGED|END-UNTRUSTED-TOOL-OUTPUT/);
    // dispatcher audit happened, and usage was recorded (budget hook fired)
    assert.ok(auditEvents.some((e) => e.kind === "provider.dispatch.completed"));
    assert.ok(auditEvents.some((e) => e.kind === "budget.record" && e.inputTokens === 12));
    void serverHitsAfterGate;
  });

  it("layered secret defense: redact at the tool edge (P3) + dispatcher backstop (T11)", async () => {
    writeFileSync(join(root, "SECRET.txt"), SECRET_FILE_CONTENT);
    const answers = [
      'Read it.\n```tool\n{"tool":"fs.read","args":{"path":"SECRET.txt"}}\n```',
      "## Summary\nwhat I read is summarized.",
    ];
    const opened = await mockProvider(answers);
    const dispatcher = new ProviderDispatcher({});
    const config = {
      id: "mock-local",
      name: "mock",
      protocol: "local-openai-compatible",
      baseUrl: opened.url,
      maxClassification: "confidential",
    };
    const transport = async (messages) => {
      const res = await dispatcher.complete(
        config,
        { model: "mock-test-model", messages: messages.map((m) => ({ role: m.role === "tool" ? "user" : m.role, content: m.content })) },
        { contextClassification: "internal" },
      );
      return { content: res.content };
    };
    const res = await investigate(
      {
        runner: new ToolRunner(FS_TOOLS),
        jailRoot: root,
        policyCtx: { workspaceLocked: false, providerMaxClassification: "confidential" },
        transport,
        task: { title: "read the secret file" },
      },
      { maxIterations: 4 },
    );
    // Layer 1: the fs.read output was redacted BEFORE reaching the transcript/prompt —
    // the wire never carries the raw token, so the run cleanly completes.
    assert.equal(res.status, "completed");
    assert.equal(opened.requests.length, 2);
    const wireAfter = posts(opened).at(-1).body.messages.map((m) => m.content).join("\n");
    assert.doesNotMatch(wireAfter, /ghp_TESTONLY/);
    assert.match(wireAfter, /REDACTED|redacted/);

    // Layer 2 (backstop): token text reaching the dispatcher through ANY lane (here
    // the task text itself) is refused pre-send — zero provider requests made.
    const echo = await mockProvider([]);
    const echoRes = await investigate(
      {
        runner: new ToolRunner(FS_TOOLS),
        jailRoot: root,
        policyCtx: { workspaceLocked: false, providerMaxClassification: "confidential" },
        transport: makeTransport(echo),
        task: { title: "summarize token ghp_TESTONLYabcdefghijklmnopqrstuv please" },
      },
      { maxIterations: 4 },
    );
    assert.equal(echoRes.status, "transport-error");
    assert.equal(echo.requests.length, 0, "gate must fire before any socket write");
  });

  it("egress gate: remote https non-allowlisted private host is denied before any socket", async () => {
    const dispatcher = new ProviderDispatcher({});
    const config = {
      id: "bad-remote",
      name: "bad",
      protocol: "openai-compatible",
      baseUrl: "https://169.254.169.254",
      maxClassification: "confidential",
    };
    await assert.rejects(
      () =>
        dispatcher.complete(
          config,
          { model: "m", messages: [{ role: "user", content: "hi" }] },
          { contextClassification: "public" },
        ),
      (err) => {
        assert.ok(err instanceof ProviderError);
        assert.equal(err.code, "EGRESS_DENIED");
        return true;
      },
    );
  });
});
