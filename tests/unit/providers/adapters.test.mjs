// Unit: adapter contracts — request/response wire shapes translated through a
// RECORDING transport (no network). Covers OpenAI/Anthropic/NVIDIA/local/generic.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createAdapter,
  ProviderError,
} from "../../../packages/providers/src/index.ts";
import { MemoryVault, secretRef, secretValue } from "../../../packages/secrets/src/index.ts";

/** Transport that records calls and replays a queue of canned responses. */
function recordingTransport(respond) {
  const calls = [];
  const transport = async (req) => {
    calls.push(req);
    const out = respond(req);
      if (out.error) throw out.error;
    return Object.freeze({ status: out.status ?? 200, body: out.body ?? "{}" });
  };
  return { calls, transport };
}

function okJson(value) {
  return { status: 200, body: JSON.stringify(value) };
}

const KEY = "sk-TESTONLY-fixture-0123456789abcdef0123456789";

async function vaultWithKey() {
  const vault = new MemoryVault();
  await vault.store(secretRef("vault://providers/p1/key"), secretValue(KEY));
  return vault;
}

function configFor(protocol, extra = {}) {
  const bases = {
    "openai-chat": "https://api.openai.test/v1",
    "anthropic-messages": "https://api.anthropic.test",
    "nvidia-nim": "https://integrate.nvidia.test/v1",
    "local-openai-compatible": "http://127.0.0.1:9/v1",
    "generic-rest": "https://generic.test",
  };
  return {
    id: "p1",
    name: "test",
    protocol,
    baseUrl: bases[protocol],
    maxClassification: "confidential",
    ...extra,
  };
}

describe("OpenAI-shaped adapters", () => {
  it("sends chat.completions shape with Bearer auth and maps the response", async () => {
    const vault = await vaultWithKey();
    const { calls, transport } = recordingTransport(() =>
      okJson({
        model: "gpt-x",
        choices: [{ message: { content: "hello there" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 11, completion_tokens: 7 },
      }),
    );
    const adapter = createAdapter(configFor("openai-chat", { credentialRef: "vault://providers/p1/key" }), {
      transport,
      resolveKey: (ref) => vault.load(secretRef(ref)).then(String),
    });
    const res = await adapter.complete({
      model: "gpt-x",
      messages: [
        { role: "system", content: "be terse" },
        { role: "user", content: "say hi" },
      ],
      maxTokens: 32,
      temperature: 0.2,
    });
    assert.equal(res.content, "hello there");
    assert.equal(res.finishReason, "stop");
    assert.deepEqual(res.usage, { inputTokens: 11, outputTokens: 7 });
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.ok(call.url.endsWith("/v1/chat/completions"));
    assert.equal(call.headers.authorization, `Bearer ${KEY}`);
    const sent = JSON.parse(call.body);
    assert.equal(sent.model, "gpt-x");
    assert.equal(sent.max_tokens, 32);
    assert.equal(sent.messages.length, 2);
    assert.equal(sent.messages[0].role, "system");
  });

  it("joins content-part arrays and maps tool_calls finish", async () => {
    const { transport } = recordingTransport(() =>
      okJson({
        model: "m",
        choices: [
          {
            message: {
              content: [
                { type: "text", text: "partA " },
                { type: "text", text: "partB" },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    );
    const adapter = createAdapter(configFor("openai-chat"), { transport });
    const res = await adapter.complete({ model: "m", messages: [{ role: "user", content: "q" }] });
    assert.equal(res.content, "partA partB");
    assert.equal(res.finishReason, "tool_calls");
  });

  it("fails closed on unknown finish reasons and missing choices", async () => {
    const { transport: t1 } = recordingTransport(() =>
      okJson({ model: "m", choices: [{ message: { content: "x" }, finish_reason: "content_filter" }] }),
    );
    const a1 = createAdapter(configFor("openai-chat"), { transport: t1 });
    const r1 = await a1.complete({ model: "m", messages: [{ role: "user", content: "q" }] });
    assert.equal(r1.finishReason, "error");
    const { transport: t2 } = recordingTransport(() => okJson({ model: "m", choices: [] }));
    const a2 = createAdapter(configFor("openai-chat"), { transport: t2 });
    await assert.rejects(
      a2.complete({ model: "m", messages: [{ role: "user", content: "q" }] }),
      (err) => err instanceof ProviderError && err.code === "VALIDATION",
    );
  });

  it("normalizes /v1/models discovery; NVIDIA NIM inherits the shape", async () => {
    const { transport } = recordingTransport(() =>
      okJson({ data: [{ id: "nim-70b" }, { id: "nim-8b" }, { nope: true }] }),
    );
    const adapter = createAdapter(configFor("nvidia-nim"), { transport });
    const models = await adapter.listModels();
    assert.deepEqual(
      models.map((m) => m.id),
      ["p1:nim-70b", "p1:nim-8b"],
    );
    assert.equal(models[0].declaredCapabilitiesVerified, false);
    assert.equal(models[0].status, "unverified");
    assert.equal(models[0].capabilities.text, true);
    assert.equal(models[0].capabilities.tools, false);
  });

  it("local adapter is keyless by default (no Authorization header)", async () => {
    const { calls, transport } = recordingTransport(() =>
      okJson({ model: "local", choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
    );
    const adapter = createAdapter(configFor("local-openai-compatible"), { transport });
    const res = await adapter.complete({ model: "local", messages: [{ role: "user", content: "q" }] });
    assert.equal(res.content, "ok");
    assert.equal(calls[0].headers.authorization, undefined);
  });
});

describe("Anthropic adapter", () => {
  function anthropicSetup() {
    const { calls, transport } = recordingTransport(() =>
      okJson({
        id: "msg_1",
        content: [
          { type: "text", text: "Hi " },
          { type: "text", text: "there" },
        ],
        stop_reason: "end_turn",
        usage: { input_tokens: 5, output_tokens: 3 },
        model: "claude-x",
      }),
    );
    return { calls, transport };
  }

  it("extracts system, sends x-api-key + anthropic-version, maps usage", async () => {
    const vault = await vaultWithKey();
    const { calls, transport } = anthropicSetup();
    const adapter = createAdapter(
      configFor("anthropic-messages", { credentialRef: "vault://providers/p1/key" }),
      { transport, resolveKey: (ref) => vault.load(secretRef(ref)).then(String) },
    );
    const res = await adapter.complete({
      model: "claude-x",
      messages: [
        { role: "system", content: "sys one" },
        { role: "system", content: "sys two" },
        { role: "user", content: "hello" },
        { role: "assistant", content: "earlier" },
        { role: "user", content: "follow up" },
      ],
    });
    assert.equal(res.content, "Hi there");
    assert.equal(res.finishReason, "stop");
    assert.deepEqual(res.usage, { inputTokens: 5, outputTokens: 3 });
    const call = calls[0];
    assert.ok(call.url.endsWith("/v1/messages"));
    assert.equal(call.headers["x-api-key"], KEY);
    assert.equal(call.headers["anthropic-version"], "2023-06-01");
    const sent = JSON.parse(call.body);
    assert.equal(sent.system, "sys one\n\nsys two");
    assert.equal(sent.messages.length, 3);
    assert.equal(sent.max_tokens, 1024); // required default
  });

  it("rejects tool-role messages explicitly (Phase 2 scope)", async () => {
    const { transport } = anthropicSetup();
    const adapter = createAdapter(configFor("anthropic-messages"), { transport });
    await assert.rejects(
      adapter.complete({ model: "c", messages: [{ role: "tool", content: "out" }] }),
      (err) => err instanceof ProviderError && err.code === "VALIDATION",
    );
  });

  it("normalizes /v1/models discovery (keyed)", async () => {
    const vault = await vaultWithKey();
    const { transport } = recordingTransport(() =>
      okJson({ data: [{ id: "claude-opus" }, { id: "claude-haiku" }], has_more: false }),
    );
    const adapter = createAdapter(
      configFor("anthropic-messages", { credentialRef: "vault://providers/p1/key" }),
      { transport, resolveKey: (ref) => vault.load(secretRef(ref)).then(String) },
    );
    const models = await adapter.listModels();
    assert.deepEqual(models.map((m) => m.id), ["p1:claude-opus", "p1:claude-haiku"]);
  });

  it("keyless anthropic config fails AUTH before any send", async () => {
    const { calls, transport } = recordingTransport(() => okJson({ data: [] }));
    const adapter = createAdapter(configFor("anthropic-messages"), { transport });
    await assert.rejects(adapter.listModels(), (err) => err instanceof ProviderError && err.code === "AUTH");
    assert.equal(calls.length, 0, "no request should leave without credentials");
  });
});

describe("Generic REST adapter", () => {
  it("honors configured paths + key styles", async () => {
    const vault = await vaultWithKey();
    const { calls, transport } = recordingTransport(() =>
      okJson({ result: { text: "generic says hi", meta: { in: 9, out: 4 } } }),
    );
    const adapter = createAdapter(
      configFor("generic-rest", {
        credentialRef: "vault://providers/p1/key",
        config: {
          chatPath: "api/chat",
          contentPath: "result.text",
          usageInputPath: "result.meta.in",
          usageOutputPath: "result.meta.out",
          keyStyle: "x-api-key",
        },
      }),
      { transport, resolveKey: (ref) => vault.load(secretRef(ref)).then(String) },
    );
    const res = await adapter.complete({ model: "g1", messages: [{ role: "user", content: "q" }] });
    assert.equal(res.content, "generic says hi");
    assert.deepEqual(res.usage, { inputTokens: 9, outputTokens: 4 });
    assert.ok(calls[0].url.endsWith("/api/chat"));
    assert.equal(calls[0].headers["x-api-key"], KEY);
  });

  it("fails VALIDATION when the configured content path is missing", async () => {
    const { transport } = recordingTransport(() => okJson({ totally: "different" }));
    const adapter = createAdapter(
      configFor("generic-rest", { config: { keyStyle: "none" } }),
      { transport },
    );
    await assert.rejects(
      adapter.complete({ model: "g1", messages: [{ role: "user", content: "q" }] }),
      (err) => err instanceof ProviderError && err.code === "VALIDATION",
    );
  });

  it("unsupported protocols are rejected at the factory", () => {
    assert.throws(
      () => createAdapter(configFor("openai-chat", { protocol: "gemini" }), { transport: async () => ({ status: 200, body: "{}" }) }),
      (err) => err instanceof ProviderError && err.code === "PROTOCOL_UNSUPPORTED",
    );
  });
});
