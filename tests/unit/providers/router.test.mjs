// Unit: FailoverRouter — the failover matrix (P2.6). Candidates are classification-
// filtered pre-hop; transient failures hop to the next provider and persist status;
// request-scoped failures stop the chain; exhaustions carry code-only hop notes.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../../packages/storage/src/database.ts";
import { ModelsDao, ProvidersDao } from "../../../packages/storage/src/dao-providers.ts";
import {
  FailoverRouter,
  ProviderDispatcher,
  ProviderError,
} from "../../../packages/providers/src/index.ts";

function cfg(id, maxClassification = "confidential") {
  return {
    id,
    name: id,
    protocol: "openai-chat",
    baseUrl: `https://${id}.test/v1`, // plan keys route by provider id
    maxClassification,
  };
}

const REQUEST = { model: "m", messages: [{ role: "user", content: "hi" }] };
const OPTS = { contextClassification: "internal" };

function successBody(content = "ok") {
  return Object.freeze({
    status: 200,
    body: JSON.stringify({
      model: "m",
      choices: [{ message: { content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 2, completion_tokens: 1 },
    }),
  });
}

/** Route-plan interpreter: per provider id, a list of behaviors for complete(); health ok default. */
function build(plan) {
  const calls = [];
  const dispatcher = new ProviderDispatcher({
    transport: async (req) => {
      calls.push(req.url);
      const url = req.url;
      if (url.includes("/models")) return Object.freeze({ status: 200, body: JSON.stringify({ data: [] }) });
      return behaviorFor(url)();
    },
  });
  function behaviorFor(url) {
    for (const [hostFragment, queue] of Object.entries(plan)) {
      if (url.includes(hostFragment) && queue.length > 0) return queue.shift();
    }
    return () => successBody("default");
  }
  return { calls, dispatcher };
}

let dir;
let db;
let models;
let providers;
const events = [];

beforeEach(() => {
  events.length = 0;
  dir = mkdtempSync(join(tmpdir(), "aice-router-"));
  const opened = openDatabase(join(dir, "app.db"));
  db = opened.db;
  models = new ModelsDao(db);
  providers = new ProvidersDao(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedModel(pid, name) {
  providers.upsert({ id: pid, name: pid, protocol: "openai-chat", baseUrl: "https://ok.test/v1" });
  models.upsert({ providerId: pid, name });
}

describe("FailoverRouter", () => {
  it("first candidate succeeds → returns immediately, marks available", async () => {
    seedModel("p-a", "m");
    const { dispatcher } = build({ "p-a.test": [() => successBody("A ok")] });
    const router = new FailoverRouter({ dispatcher, models, healthTtlMs: 0, audit: (e) => events.push(e) });
    const res = await router.complete([{ config: cfg("p-a"), model: "m" }], REQUEST, OPTS);
    assert.equal(res.content, "A ok");
    assert.equal(models.get("p-a:m").status, "available");
  });

  it("transient on A → succeeds on B; A marked degraded, hop notes audited", async () => {
    seedModel("p-a", "m");
    seedModel("p-b", "m");
    const { dispatcher } = build({
      "p-a.test": [() => { throw new ProviderError("RATE_LIMIT", "429"); }],
      "p-b.test": [() => successBody("B ok")],
    });
    const router = new FailoverRouter({ dispatcher, models, healthTtlMs: 0, audit: (e) => events.push(e) });
    const res = await router.complete(
      [
        { config: cfg("p-a"), model: "m" },
        { config: cfg("p-b"), model: "m" },
      ],
      REQUEST,
      OPTS,
    );
    assert.equal(res.content, "B ok");
    assert.equal(models.get("p-a:m").status, "degraded");
    assert.equal(models.get("p-b:m").status, "available");
    const hops = events.filter((e) => e.kind === "provider.route.hop");
    assert.equal(hops.length, 2);
    assert.match(JSON.stringify(events), /RATE_LIMIT/);
  });

  it("AUTH on A → marked unavailable, hops to B", async () => {
    seedModel("p-a", "m");
    seedModel("p-b", "m");
    const { dispatcher } = build({
      "p-a.test": [() => { throw new ProviderError("AUTH", "bad key"); }],
      "p-b.test": [() => successBody("B ok")],
    });
    const router = new FailoverRouter({ dispatcher, models, healthTtlMs: 0 });
    const res = await router.complete(
      [
        { config: cfg("p-a"), model: "m" },
        { config: cfg("p-b"), model: "m" },
      ],
      REQUEST,
      OPTS,
    );
    assert.equal(res.content, "B ok");
    assert.equal(models.get("p-a:m").status, "unavailable");
  });

  it("request-scoped VALIDATION stops the chain (no second hop)", async () => {
    const { calls, dispatcher } = build({
      "p-a.test": [() => { throw new ProviderError("VALIDATION", "bad shape"); }],
      "p-b.test": [() => successBody("should not happen")],
    });
    const router = new FailoverRouter({ dispatcher, healthTtlMs: 0 });
    await assert.rejects(
      router.complete(
        [
          { config: cfg("p-a"), model: "m" },
          { config: cfg("p-b"), model: "m" },
        ],
        REQUEST,
        OPTS,
      ),
      (err) => err instanceof ProviderError && err.code === "VALIDATION",
    );
    assert.equal(
      calls.filter((u) => !u.includes("/models")).length,
      1,
      "chain must stop on request-scoped failure",
    );
  });

  it("classification over-clearance candidates are skipped WITHOUT burning hops", async () => {
    seedModel("p-b", "m");
    const { dispatcher } = build({ "p-b.test": [() => successBody("fine")] });
    const router = new FailoverRouter({ dispatcher, healthTtlMs: 0, audit: (e) => events.push(e) });
    const res = await router.complete(
      [
        { config: cfg("p-a", "public"), model: "m" }, // internal context can't go to public-only provider
        { config: cfg("p-b"), model: "m" },
      ],
      REQUEST,
      { contextClassification: "internal" },
    );
    assert.equal(res.content, "fine");
    const skipped = events.find((e) => e.code === "CLASSIFICATION_DENIED");
    assert.ok(skipped, "skip recorded");
  });

  it("exhaustion: all candidates fail → SERVER with code-only hop notes", async () => {
    const { dispatcher } = build({
      "p-a.test": [() => { throw new ProviderError("RATE_LIMIT", "429"); }],
      "p-b.test": [() => { throw new ProviderError("SERVER", "500"); }],
    });
    const router = new FailoverRouter({ dispatcher, healthTtlMs: 0 });
    await assert.rejects(
      router.complete(
        [
          { config: cfg("p-a"), model: "m" },
          { config: cfg("p-b"), model: "m" },
        ],
        REQUEST,
        OPTS,
      ),
      (err) =>
        err instanceof ProviderError &&
        err.code === "SERVER" &&
        /RATE_LIMIT/.test(err.message) &&
        /SERVER/.test(err.message) &&
        !/hi/.test(err.message), // no request content in the note
    );
  });

  it("health cache respects TTL (second call within TTL does not re-probe)", async () => {
    let modelsCalls = 0;
    const dispatcher = new ProviderDispatcher({
      transport: async () => {
        modelsCalls += 1; // dispatcher.health → listModels only
        return Object.freeze({ status: 200, body: JSON.stringify({ data: [] }) });
      },
    });
    const router = new FailoverRouter({ dispatcher, healthTtlMs: 60_000 });
    await router.health(cfg("p-a"));
    await router.health(cfg("p-a"));
    assert.equal(modelsCalls, 1);
    const fresh = new FailoverRouter({ dispatcher, healthTtlMs: 0 });
    await fresh.health(cfg("p-a"));
    await fresh.health(cfg("p-a"));
    assert.equal(modelsCalls, 3);
  });

  it("unhealthy candidates are skipped within the same run", async () => {
    let healthy = false;
    const dispatcher = new ProviderDispatcher({
      transport: async (req) => {
        if (req.url.includes("/models") && req.url.includes("dead.test")) {
          throw new ProviderError("NETWORK", "conn refused");
        }
        healthy = true;
        return successBody("alive");
      },
    });
    const router = new FailoverRouter({ dispatcher, healthTtlMs: 0 });
    const res = await router.complete(
      [
        { config: { ...cfg("p-dead"), baseUrl: "https://dead.test/v1" }, model: "m" },
        { config: cfg("p-live"), model: "m" },
      ],
      REQUEST,
      OPTS,
    );
    assert.equal(res.content, "alive");
    assert.equal(healthy, true);
  });
});
