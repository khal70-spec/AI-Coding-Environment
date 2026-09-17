// Unit: provider/credential/model DAOs — vault refs only, config JSON validation,
// upsert/cascade semantics, model natural ids + status/verification transitions.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../../packages/storage/src/database.ts";
import {
  ProvidersDao,
  ProviderCredentialsDao,
  ModelsDao,
  MODEL_STATUSES,
  DEFAULT_MODEL_CONTEXT_WINDOW,
} from "../../../packages/storage/src/dao-providers.ts";

let dir;
let db;
let providers;
let creds;
let models;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aice-pdao-"));
  const opened = openDatabase(join(dir, "app.db")); // migrate-on-open
  db = opened.db;
  providers = new ProvidersDao(db);
  creds = new ProviderCredentialsDao(db);
  models = new ModelsDao(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("ProvidersDao", () => {
  it("upserts, reads, lists with enabled filter, validates fields", () => {
    const id = providers.upsert({
      name: "Primary",
      protocol: "openai-chat",
      baseUrl: "https://api.openai.com/v1",
      maxClassification: "confidential",
      configJson: JSON.stringify({ keyStyle: "bearer" }),
    });
    const row = providers.get(id);
    assert.equal(row.maxClassification, "confidential");
    assert.equal(row.enabled, true);
    assert.equal(row.configJson, '{"keyStyle":"bearer"}');
    assert.equal(providers.list().length, 1);
    assert.equal(providers.list({ enabledOnly: true }).length, 1);

    providers.upsert({ id, name: "Renamed", protocol: "openai-chat", baseUrl: "https://api.openai.com/v1" });
    assert.equal(providers.get(id).name, "Renamed");
    assert.equal(providers.get(id).maxClassification, "internal"); // upsert default on omitted

    assert.throws(() => providers.upsert({ name: "", protocol: "x", baseUrl: "b" }), /provider name required/);
    assert.throws(() => providers.upsert({ name: "n", protocol: "x", baseUrl: "b", configJson: "{nope" }), SyntaxError);
    assert.throws(() => providers.upsert({ name: "n", protocol: "x", baseUrl: "b", maxClassification: "god-mode" }), /invalid data classification/);
  });

  it("setEnabled flips the flag and fails closed on unknown ids", () => {
    const id = providers.upsert({ name: "p", protocol: "generic-rest", baseUrl: "https://g.test" });
    providers.setEnabled(id, false);
    assert.equal(providers.list({ enabledOnly: true }).length, 0);
    assert.throws(() => providers.setEnabled("missing", true), /unknown provider/);
  });
});

describe("ProviderCredentialsDao", () => {
  it("stores vault:// refs only — values are structurally rejected", () => {
    const id = providers.upsert({ name: "p", protocol: "openai-chat", baseUrl: "https://api.openai.com/v1" });
    assert.throws(
      () => creds.set(id, "sk-TESTONLY-live-should-never-be-here"),
      /vault:\/\/ reference/,
    );
    creds.set(id, "vault://providers/p/key", "abcd");
    const row = creds.get(id);
    assert.equal(row.vaultRef, "vault://providers/p/key");
    assert.equal(row.last4, "abcd");
    // rotate: same PK upsert replaces
    creds.set(id, "vault://providers/p/key-v2", "wxyz90");
    assert.equal(creds.get(id).vaultRef, "vault://providers/p/key-v2");
    assert.equal(creds.get(id).last4, "yz90");
  });
});

describe("ModelsDao", () => {
  it("natural ids, status transitions, verification flag", () => {
    const pid = providers.upsert({ name: "p", protocol: "nvidia-nim", baseUrl: "https://n.test/v1" });
    const mid = models.upsert({ providerId: pid, name: "nim-70b" });
    assert.equal(mid, `${pid}:nim-70b`);
    let row = models.get(mid);
    assert.equal(row.status, "unverified");
    assert.equal(row.verified, false);
    assert.equal(row.contextWindow, DEFAULT_MODEL_CONTEXT_WINDOW);

    models.upsert({ providerId: pid, name: "nim-70b", displayName: "NIM 70B", contextWindow: 131_072 });
    row = models.get(mid);
    assert.equal(row.displayName, "NIM 70B");
    assert.equal(row.contextWindow, 131_072);
    assert.equal(row.status, "unverified", "re-discovery must not clobber status");

    models.setStatus(mid, "available");
    models.setVerified(mid, true);
    row = models.get(mid);
    assert.equal(row.status, "available");
    assert.equal(row.verified, true);
    assert.throws(() => models.setStatus(mid, "purple"), /invalid model status/);
    assert.ok(MODEL_STATUSES.includes("degraded"));
    assert.equal(models.listByProvider(pid).length, 1);
  });
});

describe("cascade", () => {
  it("removing a provider cascades credentials + models (FK)", () => {
    const pid = providers.upsert({ name: "p", protocol: "openai-chat", baseUrl: "https://api.openai.com/v1" });
    creds.set(pid, "vault://providers/p/key");
    const mid = models.upsert({ providerId: pid, name: "m1" });
    providers.remove(pid);
    assert.equal(providers.get(pid), undefined);
    assert.equal(creds.get(pid), undefined);
    assert.equal(models.get(mid), undefined);
  });
});
