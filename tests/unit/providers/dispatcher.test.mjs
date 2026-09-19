// Unit: dispatcher gates — classification, egress, outbound-secret, key resolution,
// content-free audit events. Uses recording transports + a real loopback server for
// the full local-adapter path.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  ProviderDispatcher,
  ProviderError,
  fetchTransport,
} from "../../../packages/providers/src/index.ts";
import { MemoryVault, secretRef, secretValue } from "../../../packages/secrets/src/index.ts";

const KEY = "sk-TESTONLY-dispatch-abcdef0123456789abcdef0123456789";

function remoteConfig(overrides = {}) {
  return {
    id: "p-remote",
    name: "remote",
    protocol: "openai-chat",
    baseUrl: "https://api.openai.test/v1",
    maxClassification: "internal",
    ...overrides,
  };
}

describe("dispatcher gates", () => {
  it("classification gate: confidential context vs internal-cleared provider", async () => {
    const seen = [];
    const d = new ProviderDispatcher({
      transport: async () => {
        seen.push(1);
        return Object.freeze({ status: 200, body: "{}" });
      },
    });
    await assert.rejects(
      d.complete(remoteConfig(), { model: "m", messages: [{ role: "user", content: "q" }] }, {
        contextClassification: "confidential",
      }),
      (err) => err instanceof ProviderError && err.code === "CLASSIFICATION_DENIED",
    );
    assert.equal(seen.length, 0, "transport must never be reached when the gate denies");
  });

  it("egress gate: remote http / private ip / credentialed URL denied pre-transport", async () => {
    const seen = [];
    const d = new ProviderDispatcher({
      transport: async () => {
        seen.push(1);
        return Object.freeze({ status: 200, body: "{}" });
      },
    });
    for (const cfg of [
      remoteConfig({ baseUrl: "http://api.openai.test/v1" }),
      remoteConfig({ baseUrl: "https://192.168.0.1/v1" }),
      remoteConfig({ baseUrl: "https://k:sk-bad@api.openai.test/v1" }),
    ]) {
      await assert.rejects(
        d.listModels(cfg),
        (err) => err instanceof ProviderError && err.code === "EGRESS_DENIED",
      );
    }
    assert.equal(seen.length, 0);
  });

  it("secret gate: message containing a credential-shaped string is SECRET_IN_REQUEST", async () => {
    const events = [];
    const d = new ProviderDispatcher({
      transport: async () => Object.freeze({ status: 200, body: "{}" }),
      audit: (e) => events.push(e),
    });
    await assert.rejects(
      d.complete(
        remoteConfig(),
        { model: "m", messages: [{ role: "user", content: "paste this key: sk-ant-TESTONLY-abcdefghij0123456789" }] },
        { contextClassification: "public" },
      ),
      (err) =>
        err instanceof ProviderError &&
        err.code === "SECRET_IN_REQUEST" &&
        !String(err.message).includes("sk-ant-TESTONLY-abcdefghij0123456789") &&
        /anthropic/.test(err.message),
    );
    const denied = events.find((e) => e.kind === "provider.dispatch.denied");
    assert.ok(denied, "denial must be reported to the audit sink");
    assert.equal(denied.code, "SECRET_IN_REQUEST");
    assert.ok(!JSON.stringify(events).includes("sk-ant-TESTONLY-abcdefghij0123456789"));
  });

  it("completed dispatches emit content-free audit events with usage", async () => {
    const events = [];
    const d = new ProviderDispatcher({
      transport: async () =>
        Object.freeze({
          status: 200,
          body: JSON.stringify({
            model: "m",
            choices: [{ message: { content: "done" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 2, completion_tokens: 1 },
          }),
        }),
      audit: (e) => events.push(e),
    });
    const res = await d.complete(
      remoteConfig({ maxClassification: "confidential" }),
      { model: "m", messages: [{ role: "user", content: "internal memo" }] },
      { contextClassification: "confidential" },
    );
    assert.equal(res.content, "done");
    const done = events.find((e) => e.kind === "provider.dispatch.completed");
    assert.equal(done.inputTokens, 2);
    assert.equal(done.outputTokens, 1);
  });

  it("provider failures emit redacted failure events", async () => {
    const events = [];
    const d = new ProviderDispatcher({
      transport: async () => {
        throw new ProviderError("AUTH", `auth failed for key sk-TESTONLY-abcdef0123456789abcdef0123456789abcdef`);
      },
      audit: (e) => events.push(e),
    });
    await assert.rejects(
      d.complete(
        remoteConfig({ maxClassification: "confidential" }),
        { model: "m", messages: [{ role: "user", content: "q" }] },
        { contextClassification: "public" },
      ),
      (err) => err instanceof ProviderError && err.code === "AUTH",
    );
    const failed = events.find((e) => e.kind === "provider.dispatch.failed");
    assert.ok(failed);
    assert.ok(!JSON.stringify(events).includes("sk-TESTONLY-abcdef0123456789abcdef0123456789abcdef"));
  });
});

// Full path through a REAL loopback server + MemoryVault (local adapter end-to-end).
describe("dispatcher + local adapter + vault (loopback)", () => {
  let server;
  let port;
  let state;
  before(async () => {
    state = { seen: [], handler: () => ({ status: 200, body: { data: [] } }) };
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
  after(async () => new Promise((resolve) => server.close(resolve)));

  function localConfig(overrides = {}) {
    return {
      id: "p-local",
      name: "local",
      protocol: "local-openai-compatible",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      maxClassification: "confidential",
      ...overrides,
    };
  }

  it("healthy connection test reports models found", async () => {
    state.handler = () => ({ status: 200, body: { data: [{ id: "q4" }, { id: "q5" }] } });
    const d = new ProviderDispatcher({ transport: fetchTransport() });
    const report = await d.testConnection(localConfig());
    assert.equal(report.ok, true);
    assert.equal(report.modelsFound, 2);
  });

  it("failing endpoint reports redacted detail, code, no body leak", async () => {
    state.handler = () => ({ status: 500, body: `crash sk-ant-TESTONLY-redacted0000secret999` });
    const events = [];
    const d = new ProviderDispatcher({ transport: fetchTransport(), audit: (e) => events.push(e) });
    const report = await d.testConnection(localConfig());
    assert.equal(report.ok, false);
    assert.ok(!report.detail.includes("sk-ant-TESTONLY-redacted0000secret999"));
    const evt = events.find((e) => e.kind === "provider.connection.tested");
    assert.equal(evt.code, "SERVER");
  });

  it("authed dispatch resolves the vault ref and sends Bearer only in header", async () => {
    const vault = new MemoryVault();
    await vault.store(secretRef("vault://providers/p-local/key"), secretValue(KEY));
    state.handler = () => ({
      status: 200,
      body: { model: "q4", choices: [{ message: { content: "secure" }, finish_reason: "stop" }] },
    });
    const d = new ProviderDispatcher({ transport: fetchTransport(), vault });
    const res = await d.complete(
      localConfig({ credentialRef: "vault://providers/p-local/key" }),
      { model: "q4", messages: [{ role: "user", content: "hi" }] },
      { contextClassification: "internal" },
    );
    assert.equal(res.content, "secure");
    const sent = state.seen.at(-1);
    assert.equal(sent.headers.authorization, `Bearer ${KEY}`);
  });

  it("missing credential in vault → AUTH (not a raw vault error)", async () => {
    state.handler = () => ({ status: 200, body: { data: [] } });
    const d = new ProviderDispatcher({ transport: fetchTransport(), vault: new MemoryVault() });
    await assert.rejects(
      d.complete(
        localConfig({ credentialRef: "vault://providers/absent/key" }),
        { model: "q4", messages: [{ role: "user", content: "hi" }] },
        { contextClassification: "internal" },
      ),
      (err) => err instanceof ProviderError && err.code === "AUTH",
    );
  });
});
