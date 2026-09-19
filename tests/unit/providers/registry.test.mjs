// Unit: discovery → DB merge, capability probes, DB-backed registry (P2.5).
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../../packages/storage/src/database.ts";
import { ModelsDao, ProvidersDao } from "../../../packages/storage/src/dao-providers.ts";
import {
  ProviderDispatcher,
  discoverIntoDb,
  probeAll,
  probeModel,
  DbModelRegistry,
  ProviderError,
} from "../../../packages/providers/src/index.ts";

const CONFIG = {
  id: "p1",
  name: "test",
  protocol: "openai-chat",
  baseUrl: "https://api.openai.test/v1",
  maxClassification: "confidential",
};

function dispatcherResponding(respond) {
  return new ProviderDispatcher({
    transport: async () => Object.freeze(respond()),
  });
}

function modelsBody(ids) {
  return Object.freeze({
    status: 200,
    body: JSON.stringify({ data: ids.map((id) => ({ id })) }),
  });
}

function completeBody(content, finish = "stop") {
  return Object.freeze({
    status: 200,
    body: JSON.stringify({
      model: "m",
      choices: [{ message: { content }, finish_reason: finish }],
      usage: { prompt_tokens: 4, completion_tokens: 1 },
    }),
  });
}

let dir;
let db;
let providers;
let models;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aice-reg-"));
  const opened = openDatabase(join(dir, "app.db"));
  db = opened.db;
  models = new ModelsDao(db);
  providers = new ProvidersDao(db);
  providers.upsert({ id: CONFIG.id, name: "test", protocol: "openai-chat", baseUrl: CONFIG.baseUrl });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("discoverIntoDb", () => {
  it("merges discovery; re-discovery preserves status/verification", async () => {
    const d = dispatcherResponding(() => modelsBody(["m-a", "m-b"]));
    const first = await discoverIntoDb(CONFIG, d, models);
    assert.deepEqual(
      { total: first.totalFound, added: first.added, updated: first.updated },
      { total: 2, added: 2, updated: 0 },
    );
    models.setStatus("p1:m-a", "available");
    models.setVerified("p1:m-a", true);
    const d2 = dispatcherResponding(() => modelsBody(["m-a", "m-b", "m-c"]));
    const second = await discoverIntoDb(CONFIG, d2, models);
    assert.deepEqual(
      { added: second.added, updated: second.updated },
      { added: 1, updated: 2 },
    );
    assert.equal(models.get("p1:m-a").status, "available", "status survives re-discovery");
    assert.equal(models.get("p1:m-a").verified, true);
    assert.equal(models.listByProvider(CONFIG.id).length, 3);
  });
});

describe("capability probes", () => {
  async function seed() {
    const d = dispatcherResponding(() => modelsBody(["m-1", "m-2"]));
    await discoverIntoDb(CONFIG, d, models);
  }

  it("pass → verified + available", async () => {
    await seed();
    const d = dispatcherResponding(() => completeBody("pong"));
    const report = await probeModel(CONFIG, d, models, "p1:m-1");
    assert.equal(report.ok, true);
    assert.equal(report.statusAfter, "available");
    assert.equal(models.get("p1:m-1").verified, true);
    assert.equal(models.get("p1:m-1").status, "available");
  });

  it("answered-but-wrong → degraded (not verified)", async () => {
    await seed();
    const d = dispatcherResponding(() => completeBody("Here is my thoughtful answer"));
    const report = await probeModel(CONFIG, d, models, "p1:m-1");
    assert.equal(report.ok, false);
    assert.equal(report.statusAfter, "degraded");
    assert.equal(models.get("p1:m-1").verified, false);
    assert.equal(models.get("p1:m-1").status, "degraded");
  });

  it("truncated probe (finish=length) → degraded", async () => {
    await seed();
    const d = dispatcherResponding(() => completeBody("pon", "length"));
    const report = await probeModel(CONFIG, d, models, "p1:m-1");
    assert.equal(report.statusAfter, "degraded");
  });

  it("AUTH failure → unavailable; transient → stays unverified", async () => {
    await seed();
    const auth = new ProviderDispatcher({
      transport: async () => {
        throw new ProviderError("AUTH", "denied");
      },
    });
    const r1 = await probeModel(CONFIG, auth, models, "p1:m-1");
    assert.equal(r1.statusAfter, "unavailable");
    assert.equal(models.get("p1:m-1").status, "unavailable");

    const flaky = new ProviderDispatcher({
      transport: async () => {
        throw new ProviderError("RATE_LIMIT", "slow");
      },
    });
    const r2 = await probeModel(CONFIG, flaky, models, "p1:m-2");
    assert.equal(r2.statusAfter, "unverified");
    assert.equal(models.get("p1:m-2").status, "unverified");
  });

  it("probeAll covers every discovered model", async () => {
    await seed();
    const d = dispatcherResponding(() => completeBody("pong"));
    const reports = await probeAll(CONFIG, d, models);
    assert.equal(reports.length, 2);
    assert.ok(reports.every((r) => r.ok));
  });
});

describe("DbModelRegistry", () => {
  it("register/get/list/listByCapability/setStatus over the models table", async () => {
    const reg = new DbModelRegistry(models);
    const emptyCaps = Object.fromEntries(
      ["text", "vision", "audio", "tools", "structured-output", "reasoning", "coding", "long-context", "streaming", "parallel-tools", "computer-use", "embeddings", "image-generation"].map((k) => [k, false]),
    );
    reg.register({
      id: "p1:m-a",
      providerId: "p1",
      displayName: "Model A",
      capabilities: { ...emptyCaps, text: true, tools: true },
      contextWindow: 128_000,
      declaredCapabilitiesVerified: true,
      status: "unverified",
    });
    assert.equal(reg.get("p1:m-a").status, "unverified");
    assert.equal(reg.list().length, 1);
    assert.equal(reg.listByCapability("tools").length, 0, "not usable until available");
    models.setStatus("p1:m-a", "available");
    assert.equal(reg.listByCapability("tools").length, 1);
    assert.equal(reg.listByCapability("vision").length, 0);
    reg.setStatus("p1:m-a", "degraded");
    assert.equal(reg.get("p1:m-a").status, "degraded");
    assert.throws(
      () => reg.register({ id: "WRONG", providerId: "p1", displayName: "x", capabilities: emptyCaps, contextWindow: 1, declaredCapabilitiesVerified: false, status: "unverified" }),
      /providerId/,
    );
  });
});
