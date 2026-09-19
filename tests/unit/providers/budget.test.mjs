// Unit: budget DAOs + window math + enforcer + dispatcher integration (P2.7).
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { openDatabase } from "../../../packages/storage/src/database.ts";
import {
  BudgetsDao,
  BudgetEventsDao,
  ModelsDao,
  ProvidersDao,
} from "../../../packages/storage/src/index.ts";
import {
  BudgetEnforcer,
  ProviderDispatcher,
  ProviderError,
  fetchTransport,
  windowStartIso,
} from "../../../packages/providers/src/index.ts";

const NOW = new Date("2026-09-17T10:00:00.000Z"); // Thursday (UTC day = 4)

describe("windowStartIso (UTC)", () => {
  it("daily = midnight today; monthly = the 1st; weekly = Monday; total = null", () => {
    assert.equal(windowStartIso(NOW, "daily"), "2026-09-17T00:00:00.000Z");
    assert.equal(windowStartIso(NOW, "monthly"), "2026-09-01T00:00:00.000Z");
    assert.equal(windowStartIso(NOW, "weekly"), "2026-09-14T00:00:00.000Z");
    assert.equal(windowStartIso(NOW, "total"), null);
    // Sunday-boundary: Sunday belongs to the week that started the prior Monday
    const sun = new Date("2026-09-20T09:00:00.000Z");
    assert.equal(windowStartIso(sun, "weekly"), "2026-09-14T00:00:00.000Z");
    const mon = new Date("2026-09-21T09:00:00.000Z");
    assert.equal(windowStartIso(mon, "weekly"), "2026-09-21T00:00:00.000Z");
  });
});

let dir;
let db;
let budgets;
let events;
let models;
let providers;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aice-budget-"));
  const opened = openDatabase(join(dir, "app.db"));
  db = opened.db;
  budgets = new BudgetsDao(db);
  events = new BudgetEventsDao(db);
  models = new ModelsDao(db);
  providers = new ProvidersDao(db);
  providers.upsert({ id: "p1", name: "p1", protocol: "openai-chat", baseUrl: "https://x.test/v1" });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("BudgetsDao + BudgetEventsDao", () => {
  it("set validates: at least one limit, sane values, upsert by tuple", () => {
    assert.throws(() => budgets.set({ scope: "provider", scopeId: "p1", window: "daily" }), /at least one limit/);
    assert.throws(() => budgets.set({ scope: "provider", scopeId: "p1", window: "daily", limitUsd: -1 }), /non-negative/);
    assert.throws(() => budgets.set({ scope: "purple", scopeId: "p1", window: "daily", limitUsd: 1 }), /invalid budget scope/);
    const id1 = budgets.set({ scope: "provider", scopeId: "p1", window: "daily", limitUsd: 5 });
    const id2 = budgets.set({ scope: "provider", scopeId: "p1", window: "daily", limitTokensIn: 1000 });
    assert.equal(id1, id2, "same scope+window upserts in place");
    const row = budgets.get(id2);
    assert.equal(row.limitUsd, null);
    assert.equal(row.limitTokensIn, 1000);
    assert.equal(row.hardBlock, true);
    assert.equal(budgets.list().length, 1);
    budgets.remove(id2);
    assert.equal(budgets.list().length, 0);
  });

  it("sumsSince filters by scope, window start and decision", () => {
    events.append({ at: "2026-09-17T01:00:00Z", providerId: "p1", modelId: "p1:m", tokensIn: 10, tokensOut: 5, costUsd: 0.01, decision: "allowed" });
    events.append({ at: "2026-09-16T23:00:00Z", providerId: "p1", modelId: "p1:m", tokensIn: 99, tokensOut: 99, costUsd: 1, decision: "allowed" }); // previous day
    events.append({ at: "2026-09-17T02:00:00Z", providerId: "p1", modelId: "p1:m", tokensIn: 0, tokensOut: 0, costUsd: 0, decision: "blocked" });
    const today = events.sumsSince("provider", "p1", "2026-09-17T00:00:00Z");
    assert.deepEqual({ ti: today.tokensIn, to: today.tokensOut, cu: today.costUsd }, { ti: 10, to: 5, cu: 0.01 });
    const total = events.sumsSince("provider", "p1", null);
    assert.equal(total.tokensIn, 109);
    assert.equal(total.events, 2, "blocked rows never count as spend");
    assert.equal(events.listRecent({ providerId: "p1" }).length, 3);
  });
});

describe("BudgetEnforcer.guard", () => {
  it("allows under-limit spend, blocks at/above limit (pre-dispatch semantics)", () => {
    const e = new BudgetEnforcer({ budgets, events, models, now: () => NOW });
    budgets.set({ scope: "provider", scopeId: "p1", window: "daily", limitTokensIn: 100 });
    // 60+40 = 100 → next request must be refused
    events.append({ at: "2026-09-17T01:00:00Z", providerId: "p1", tokensIn: 60, tokensOut: 0, costUsd: 0, decision: "allowed" });
    events.append({ at: "2026-09-17T02:00:00Z", providerId: "p1", tokensIn: 40, tokensOut: 0, costUsd: 0, decision: "allowed" });
    assert.throws(
      () => e.guard({ providerId: "p1", model: "m" }),
      (err) => err instanceof ProviderError && err.code === "BUDGET_EXCEEDED" && /100\/100/.test(err.message),
    );
    const blocked = events.listRecent({ providerId: "p1" })[0];
    assert.equal(blocked.decision, "blocked");
    // prior spend was aggregate-based; a fresh provider with no rows is fine
    e.guard({ providerId: "p-other", model: "m" });
  });

  it("model-scoped budgets bind to the natural model id", () => {
    const e = new BudgetEnforcer({ budgets, events, models, now: () => NOW });
    budgets.set({ scope: "model", scopeId: "p1:m-heavy", window: "total", limitTokensOut: 10 });
    events.append({ providerId: "p1", modelId: "p1:m-heavy", tokensIn: 0, tokensOut: 10, costUsd: 0, decision: "allowed" });
    assert.throws(() => e.guard({ providerId: "p1", model: "m-heavy" }), (err) => err.code === "BUDGET_EXCEEDED");
    e.guard({ providerId: "p1", model: "m-lite" }); // other model unaffected
  });

  it("record computes cost from model rates; unknown rates record $0 (token limits still enforce)", () => {
    const mid = models.upsert({ providerId: "p1", name: "m" });
    models.setCost(mid, 3.0, 15.0);
    const e = new BudgetEnforcer({ budgets, events, models, now: () => NOW });
    e.record({ providerId: "p1", model: "m", usage: { inputTokens: 1_000_000, outputTokens: 100_000 } });
    const spend = events.sumsSince("model", "p1:m", null);
    assert.ok(Math.abs(spend.costUsd - (3.0 + 1.5)) < 1e-9);
    models.setCost(mid, null, null);
    e.record({ providerId: "p1", model: "m", usage: { inputTokens: 10, outputTokens: 10 } });
    const latest = events.listRecent({ providerId: "p1" })[0];
    assert.equal(latest.costUsd, 0);
    assert.match(latest.detail ?? "", /token limits still enforce/);
  });

  it("usd budget blocks on recorded cost", () => {
    const e = new BudgetEnforcer({ budgets, events, models, now: () => NOW });
    budgets.set({ scope: "provider", scopeId: "p1", window: "monthly", limitUsd: 0.05 });
    events.append({ at: "2026-09-10T01:00:00Z", providerId: "p1", tokensIn: 1, tokensOut: 1, costUsd: 0.05, decision: "allowed" });
    assert.throws(() => e.guard({ providerId: "p1", model: "m" }), (err) => err.code === "BUDGET_EXCEEDED");
  });
});

describe("dispatcher + budget hook (loopback)", () => {
  it("block fires pre-transport; success records usage with cost", async () => {
    const server = createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            model: "m",
            choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1200, completion_tokens: 300 },
          }),
        );
      });
    });
    const port = await new Promise((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve(server.address().port)),
    );
    try {
      const mid = models.upsert({ providerId: "p1", name: "m" });
      models.setCost(mid, 1.0, 1.0);
      const enforcer = new BudgetEnforcer({ budgets, events, models, now: () => NOW });
      const d = new ProviderDispatcher({ transport: fetchTransport(), budget: enforcer });
      const cfg = {
        id: "p1",
        name: "p1",
        protocol: "local-openai-compatible",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        maxClassification: "confidential",
      };
      const req = { model: "m", messages: [{ role: "user", content: "hi" }] };
      // two calls of (1200 in+300 out) tokens — allow first, enforce immediate aggregate
      await d.complete(cfg, req, { contextClassification: "internal" });
      // first call recorded 1200 in-tokens; equality breaches the limit → next call stops
      budgets.set({ scope: "provider", scopeId: "p1", window: "daily", limitTokensIn: 1200 });
      await assert.rejects(
        d.complete(cfg, req, { contextClassification: "internal" }),
        (err) => err instanceof ProviderError && err.code === "BUDGET_EXCEEDED",
      );
      const rows = events.listRecent({ providerId: "p1" });
      assert.equal(rows.filter((r) => r.decision === "blocked").length, 1);
      const allowed = rows.find((r) => r.decision === "allowed");
      assert.equal(allowed.tokensIn, 1200);
      assert.ok(Math.abs(allowed.costUsd - 0.0015) < 1e-9);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
