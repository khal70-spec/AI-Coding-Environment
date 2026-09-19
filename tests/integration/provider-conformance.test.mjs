// Phase 10: provider conformance harness — the contract matrix lane. Each protocol
// adapter is driven against a REAL loopback HTTP mock that implements the vendor
// wire contract and records the inbound request. Verifies request shape/body/auth
// header placement + response normalization + error mapping, over the actual
// fetchTransport socket path (no stubbed transports). Live-vendor runs remain a
// credentialled CI lane on this same matrix (see dod-review).
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  createAdapter,
  fetchTransport,
  ProviderError,
} from "../../packages/providers/src/index.ts";

/* ------------------------------- mock server ------------------------------- */

function startMock(handler) {
  return new Promise((resolve) => {
    const seen = [];
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const record = { method: req.method, path: req.url, headers: req.headers, body: raw === "" ? undefined : JSON.parse(raw) };
        seen.push(record);
        const out = handler(record);
        res.writeHead(out.status ?? 200, { "content-type": "application/json", ...(out.headers ?? {}) });
        res.end(JSON.stringify(out.json));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, seen, baseUrl: `http://127.0.0.1:${server.address().port}` }));
  });
}

const stop = (s) => new Promise((r) => s.close(r));

function makeAdapter(protocol, baseUrl, extras = {}) {
  return createAdapter(
    {
      id: `p-${protocol}`,
      name: protocol,
      protocol,
      baseUrl,
      maxClassification: "Public",
      ...(extras.config !== undefined ? { config: extras.config } : {}),
      ...(extras.key !== undefined ? { credentialRef: "vault://key" } : {}),
    },
    { transport: fetchTransport(), resolveKey: async () => extras.key ?? "TESTONLY-key" },
  );
}

/* ------------------------- openai-chat (and NIM shape) ---------------------- */

test("conformance: openai-chat — models + chat + auth placement + usage/finish mapping", async () => {
    const { server, seen, baseUrl } = await startMock((req) => {
    console.error("MARK HANDLER", req.path);
    if (req.path === "/models") return { json: { data: [{ id: "gpt-test" }, { id: "gpt-2" }] } };
    assert.equal(req.path, "/chat/completions");
    return {
      json: {
        model: req.body.model,
        choices: [{ message: { content: "hello world" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 11, completion_tokens: 7 },
      },
    };
  });
  const a = makeAdapter("openai-chat", baseUrl, { key: "sk-TESTONLY" });
    const models = await a.listModels();
    assert.deepEqual(models.map((m) => m.displayName).sort(), ["gpt-2", "gpt-test"]);
  const res = await a.complete({ model: "gpt-test", messages: [{ role: "user", content: "hi" }], maxTokens: 64 });
  assert.equal(res.content, "hello world");
  assert.equal(res.finishReason, "stop");
  assert.deepEqual(res.usage, { inputTokens: 11, outputTokens: 7 });
  const chat = seen.find((r) => r.path === "/chat/completions");
  assert.equal(chat.headers.authorization, "Bearer sk-TESTONLY");
  assert.equal(chat.body.model, "gpt-test");
  assert.equal(chat.body.max_tokens, 64);
  assert.deepEqual(chat.body.messages, [{ role: "user", content: "hi" }]);
  await stop(server);
});

test("conformance: openai-chat — finish_reason table (length, tool_calls, blank→stop, content_filter→error)", async () => {
  const finishes = ["length", "tool_calls", "", "content_filter"];
  const { server, baseUrl } = await startMock(() => ({ json: { choices: [{ message: { content: "x" }, finish_reason: finishes.shift() }] } }));
  const a = makeAdapter("openai-chat", baseUrl);
  const expected = ["length", "tool_calls", "stop", "error"];
  for (const e of expected) {
    const r = await a.complete({ model: "m", messages: [{ role: "user", content: "c" }] });
    assert.equal(r.finishReason, e);
  }
  await stop(server);
});

test("conformance: openai-chat — content parts array concatenates text blocks", async () => {
  const { server, baseUrl } = await startMock(() => ({
    json: { choices: [{ message: { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }, finish_reason: "stop" }] },
  }));
  const r = await makeAdapter("openai-chat", baseUrl).complete({ model: "m", messages: [{ role: "user", content: "c" }] });
  assert.equal(r.content, "ab");
  await stop(server);
});

test("conformance: openai-chat — error mapping 401/429/413/500 with retry-after parse", async () => {
  const { server, baseUrl } = await startMock(() => {
    switch (cases.shift()) {
      case "401": return { status: 401, json: { error: { message: "bad key" } } };
      case "429": return { status: 429, headers: { "retry-after": "9" }, json: {} };
      case "413": return { status: 413, json: {} };
      default: return { status: 500, json: { error: { message: "boom" } } };
    }
  });
  const cases = ["401", "429", "413", "500"];
  const a = makeAdapter("openai-chat", baseUrl);
  for (const want of [["AUTH"], ["RATE_LIMIT", 9000], ["CONTEXT_LENGTH"], ["SERVER"]]) {
    const err = await a.complete({ model: "m", messages: [{ role: "user", content: "c" }] }).then(() => null, (e) => e);
    assert.ok(err instanceof ProviderError);
    assert.equal(err.code, want[0]);
    if (want[1] !== undefined) assert.equal(err.retryAfterMs, want[1]);
  }
  await stop(server);
});

/* --------------------------------- anthropic -------------------------------- */

test("conformance: anthropic-messages — headers, system lifting, max_tokens default, stop/usage mapping", async () => {
  const { server, seen, baseUrl } = await startMock((req) => {
    if (req.path === "/v1/models") return { json: { data: [{ id: "claude-test" }] } };
    assert.equal(req.path, "/v1/messages");
    return {
      json: { model: req.body.model, content: [{ type: "text", text: "pong" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 3 } },
    };
  });
  const a = makeAdapter("anthropic-messages", baseUrl, { key: "ak-TESTONLY" });
  const res = await a.complete({
    model: "claude-test",
    messages: [{ role: "system", content: "be terse" }, { role: "user", content: "ping" }, { role: "assistant", content: "ack" }, { role: "user", content: "ping again" }],
  });
  assert.equal(res.content, "pong");
  assert.deepEqual(res.usage, { inputTokens: 5, outputTokens: 3 });
  const chat = seen.find((r) => r.path === "/v1/messages");
  assert.equal(chat.headers["x-api-key"], "ak-TESTONLY");
  assert.equal(chat.headers["anthropic-version"], "2023-06-01");
  assert.equal(chat.body.system, "be terse");                    // lifted out of messages
  assert.deepEqual(chat.body.messages, [                          // system never sent inline
    { role: "user", content: "ping" }, { role: "assistant", content: "ack" }, { role: "user", content: "ping again" },
  ]);
  assert.equal(chat.body.max_tokens, 1024);                       // anthropic-required default
  await stop(server);
});

test("conformance: anthropic-messages — tool-role is a provider-side VALIDATION error (fail closed)", async () => {
  const a = makeAdapter("anthropic-messages", "http://127.0.0.1:9");
  const err = await a.complete({ model: "m", messages: [{ role: "tool", content: "c" }] }).then(() => null, (e) => e);
  assert.ok(err instanceof ProviderError);
  assert.equal(err.code, "VALIDATION");
});

/* ------------------------- nvidia-nim (OpenAI shape) ------------------------ */

test("conformance: nvidia-nim — identical wire shape to openai-chat at its origin", async () => {
  const { server, seen, baseUrl } = await startMock((req) =>
    req.path === "/chat/completions"
      ? { json: { choices: [{ message: { content: "nim" }, finish_reason: "stop" }] } }
      : { json: { data: [{ id: "nim-model" }] } });
  const a = makeAdapter("nvidia-nim", baseUrl);
  const r = await a.complete({ model: "nim-model", messages: [{ role: "user", content: "hi" }] });
  assert.equal(r.content, "nim");
  assert.ok(seen.some((m) => m.path === "/chat/completions"));
  await stop(server);
});

/* ------------------------------- generic-rest ------------------------------- */

test("conformance: generic-rest — configurable dot-path mapping + x-api-key style", async () => {
  const { server, seen, baseUrl } = await startMock((req) =>
    req.path === "/predict"
      ? { json: { result: { answer: { text: "42" } }, meta: { in: 2, out: 1 } } }
      : { json: { items: [{ name: "a1" }] } });
  const a = makeAdapter("generic-rest", baseUrl, {
    key: "gk-TESTONLY",
    config: { chatPath: "/predict", modelsPath: "/items", modelsListPath: "items", modelsIdPath: "name",
      contentPath: "result.answer.text", usageInputPath: "meta.in", usageOutputPath: "meta.out", keyStyle: "x-api-key" },
  });
    const models = await a.listModels();
    assert.deepEqual(models.map((m) => m.displayName), ["a1"]);
  const r = await a.complete({ model: "a1", messages: [{ role: "user", content: "q" }] });
  assert.equal(r.content, "42");
  assert.deepEqual(r.usage, { inputTokens: 2, outputTokens: 1 });
  assert.equal(seen.find((m) => m.path === "/predict").headers["x-api-key"], "gk-TESTONLY");
  await stop(server);
});

test("conformance: generic-rest — missing configured content path fails VALIDATION (no silent fallback)", async () => {
  const { server, baseUrl } = await startMock(() => ({ json: { totally: "different shape" } }));
  const err = await makeAdapter("generic-rest", baseUrl, { key: "gk-TESTONLY" })
    .complete({ model: "m", messages: [{ role: "user", content: "q" }] })
    .then(() => null, (e) => e);
  assert.ok(err instanceof ProviderError);
  assert.equal(err.code, "VALIDATION");
  await stop(server);
});

/* ----------------------------- egress hard stop ----------------------------- */

test("conformance: dispatcher-side egress policy — http://* remote endpoints refused by url policy", async () => {
  const { assertProviderEndpoint } = await import("../../packages/providers/src/http.ts");
  assert.throws(() => assertProviderEndpoint("http://api.openai-cloud.evil.example", "openai-chat"), (e) => e.code === "EGRESS_DENIED");
  // loopback both ip and named-local forms accepted
  assert.doesNotThrow(() => assertProviderEndpoint("http://127.0.0.1:1234", "local-openai-compatible"));
  assert.doesNotThrow(() => assertProviderEndpoint("http://localhost:1234", "local-openai-compatible"));
  // https remote accepted for declared vendors
  assert.doesNotThrow(() => assertProviderEndpoint("https://api.anthropic.com", "anthropic-messages"));
});
