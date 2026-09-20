// Unit: MemoryService (Plan §25) — scope/id coherence, secret-refusing writes,
// T20 cross-project isolation, deletion/purge, contained redacted export,
// retention sweep (TTL + age + budget). In-memory SQLite, real migrations.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  applyMigrations,
  defaultMigrationsDir,
  MemoryEntriesDao,
  MemoryRetentionDao,
} from "../../../packages/storage/src/index.ts";
import {
  MemoryService,
  MemoryError,
  validateRef,
  MEMORY_KEY_MAX,
  MEMORY_VALUE_JSON_MAX,
  SCRATCHPAD_DEFAULT_TTL_HOURS,
} from "../../../packages/memory/src/index.ts";

const FAKE_TOKEN = ["g", "h", "p_"].join("") + "A".repeat(24) + "-TESTONLY";

function mk() {
  const db = new DatabaseSync(":memory:");
  applyMigrations(db, defaultMigrationsDir());
  const audits = [];
  const entries = new MemoryEntriesDao(db);
  const retention = new MemoryRetentionDao(db);
  const svc = new MemoryService({ entries, retention, audit: { append: (e) => audits.push(e) } });
  return { db, svc, audits, entries, retention };
}

describe("memory refs — scope/id coherence", () => {
  it("global rejects any id; project requires projectId and rejects task/model ids", () => {
    assert.throws(() => validateRef({ scope: "global", projectId: "p1" }), /not allowed for scope global/);
    assert.throws(() => validateRef({ scope: "project" }), /requires projectId/);
    assert.throws(() => validateRef({ scope: "project", projectId: "p1", taskId: "t1" }), /not allowed/);
    assert.throws(() => validateRef({ scope: "task" }), /requires taskId/);
    assert.throws(() => validateRef({ scope: "scratchpad" }), /requires taskId/);
    assert.throws(() => validateRef({ scope: "model" }), /requires modelId/);
    assert.throws(() => validateRef({ scope: "bogus" }), /unknown memory scope/);
    const ok = validateRef({ scope: "task", taskId: " t1 ", projectId: " p1 " });
    assert.equal(ok.taskId, "t1");
    assert.equal(ok.projectId, "p1");
  });

  it("ids must be short, NUL-free, and not secret-shaped", () => {
    assert.throws(() => validateRef({ scope: "project", projectId: "x".repeat(65) }), /≤64/);
    assert.throws(
      () => validateRef({ scope: "project", projectId: "a" + String.fromCharCode(0) + "b" }),
      /NUL-free/,
    );
    assert.throws(() => validateRef({ scope: "project", projectId: FAKE_TOKEN }), /looks like a secret/);
  });
});

describe("MemoryService set/get/list/delete", () => {
  let h;
  beforeEach(() => {
    h = mk();
  });
  afterEach(() => {
    h.db.close();
  });

  it("round-trips values (JSON), upserts in place, keeps updated_at fresh", () => {
    const a = h.svc.set({ scope: "project", projectId: "p1", key: "arch", value: { db: "sqlite" }, actor: "t" });
    assert.equal(a.scope, "project");
    assert.equal(JSON.parse(a.valueJson).db, "sqlite");
    const b = h.svc.set({ scope: "project", projectId: "p1", key: "arch", value: "v2", actor: "t" });
    assert.equal(JSON.parse(b.valueJson), "v2");
    assert.equal(h.svc.list({ scope: "project", projectId: "p1" }).length, 1);
    const got = h.svc.get({ scope: "project", projectId: "p1" }, "arch");
    assert.equal(JSON.parse(got.valueJson), "v2");
  });

  it("refuses secret-shaped keys AND values (nothing persisted; denial audited)", () => {
    assert.throws(
      () => h.svc.set({ scope: "global", key: "k", value: `token=${FAKE_TOKEN}`, actor: "t" }),
      (err) => err instanceof MemoryError && err.code === "SECRET_REFUSED",
    );
    assert.throws(() => h.svc.set({ scope: "global", key: FAKE_TOKEN, value: "x", actor: "t" }), MemoryError);
    assert.equal(h.svc.list({ scope: "global" }).length, 0);
    const deny = h.audits.find((e) => e.action === "memory.set" && e.decision === "deny");
    assert.ok(deny !== undefined, "denial audited");
    assert.ok(JSON.stringify(deny.detail).includes("refused"), "audit names refusal kinds, never the value");
  });

  it("enforces size caps on key and serialized value", () => {
    assert.throws(() => h.svc.set({ scope: "global", key: "k".repeat(MEMORY_KEY_MAX + 1), value: 1, actor: "t" }), /exceeds/);
    assert.throws(
      () => h.svc.set({ scope: "global", key: "k", value: "v".repeat(MEMORY_VALUE_JSON_MAX), actor: "t" }),
      (err) => err.code === "OVER_LIMIT",
    );
  });

  it("T20: project partitions are exact — no cross-project reads, purge is partition-exact", () => {
    h.svc.set({ scope: "project", projectId: "A", key: "k1", value: 1, actor: "t" });
    h.svc.set({ scope: "project", projectId: "B", key: "k1", value: 2, actor: "t" });
    h.svc.set({ scope: "global", key: "k1", value: 3, actor: "t" });
    assert.equal(h.svc.list({ scope: "project", projectId: "A" }).length, 1);
    assert.equal(h.svc.list({ scope: "project", projectId: "B" }).length, 1);
    assert.equal(JSON.parse(h.svc.get({ scope: "project", projectId: "B" }, "k1").valueJson), 2);
    assert.equal(h.svc.list({ scope: "project", projectId: "C" }).length, 0);
    assert.equal(h.svc.purge({ scope: "project", projectId: "A" }, "t"), 1);
    assert.equal(h.svc.list({ scope: "project", projectId: "A" }).length, 0);
    assert.equal(h.svc.list({ scope: "project", projectId: "B" }).length, 1);
    assert.equal(h.svc.purge({ scope: "global" }, "t"), 1, "global partition independent");
  });

  it("delete is id-safe and audited; missing keys are a deny no-op", () => {
    h.svc.set({ scope: "task", taskId: "T1", key: "note", value: "wip", actor: "t" });
    assert.equal(h.svc.delete({ scope: "task", taskId: "T1" }, "note", "t"), true);
    assert.equal(h.svc.delete({ scope: "task", taskId: "T1" }, "note", "t"), false);
    const del = h.audits.filter((e) => e.action === "memory.delete");
    assert.equal(del.length, 2);
  });

  it("scratchpad gets a default TTL; explicit ttlHours/expiresAt honored", () => {
    const s = h.svc.set({ scope: "scratchpad", taskId: "T1", key: "n", value: 1, actor: "t" });
    assert.ok(s.expiresAt !== null, "scratchpad TTL default");
    const deltaH = (Date.parse(s.expiresAt) - Date.now()) / 3_600_000;
    assert.ok(deltaH > SCRATCHPAD_DEFAULT_TTL_HOURS - 1 && deltaH <= SCRATCHPAD_DEFAULT_TTL_HOURS, "≈7d default");
    const e = h.svc.set({ scope: "task", taskId: "T1", key: "n2", value: 1, actor: "t", ttlHours: 2 });
    assert.ok(Date.parse(e.expiresAt) > Date.parse(s.expiresAt) === false, "2h ttl < 7d");
    assert.throws(
      () => h.svc.set({ scope: "task", taskId: "T1", key: "n3", value: 1, actor: "t", expiresAt: "not-a-date" }),
      /ISO instant/,
    );
  });
});

describe("MemoryService retention + sweep", () => {
  let h;
  beforeEach(() => {
    h = mk();
  });
  afterEach(() => {
    h.db.close();
  });

  it("seeds §25 defaults; operator override wins", () => {
    assert.equal(h.svc.retentionFor("scratchpad").retentionDays, 7);
    assert.equal(h.svc.retentionFor("global").retentionDays, 0);
    h.svc.retentionSet("scratchpad", 1, 50, "t");
    assert.equal(h.svc.retentionFor("scratchpad").maxEntries, 50);
    assert.throws(() => h.svc.retentionSet("global", -1, 10, "t"), /keep forever/);
    assert.throws(() => h.svc.retentionSet("bogus", 1, 10, "t"), /unknown memory scope/);
  });

  it("sweep removes expired rows (TTL), then age-cutoff, then budget trim — audited", () => {
    // TTL lane
    h.svc.set({ scope: "task", taskId: "T1", key: "short", value: 1, actor: "t", ttlHours: 1 });
    let totals = h.svc.sweep("t", new Date(Date.now() + 2 * 3_600_000).toISOString());
    assert.equal(totals["expired"], 1);
    assert.equal(h.svc.list({ scope: "task", taskId: "T1" }).length, 0);

    // Age lane: retention 1d → a row surviving now is gone when swept in +2d
    h.svc.retentionSet("task", 1, 100, "t");
    h.svc.set({ scope: "task", taskId: "T2", key: "old", value: 1, actor: "t" });
    totals = h.svc.sweep("t", new Date(Date.now() + 2 * 86_400_000).toISOString());
    assert.equal(totals["task"], 1);

    // Budget lane: max 2 → third entry trims the oldest-updated
    h.svc.retentionSet("project", 0, 2, "t");
    h.svc.set({ scope: "project", projectId: "P", key: "a", value: 1, actor: "t" });
    h.svc.set({ scope: "project", projectId: "P", key: "b", value: 1, actor: "t" });
    h.svc.set({ scope: "project", projectId: "P", key: "c", value: 1, actor: "t" });
    totals = h.svc.sweep("t");
    assert.ok((totals["project"] ?? 0) >= 1, "trimmed to budget");
    assert.equal(h.svc.list({ scope: "project", projectId: "P" }).length, 2);
    assert.ok(h.audits.some((e) => e.action === "memory.sweep"), "sweep audited");
  });
});

describe("MemoryService export (§25)", () => {
  let h;
  let dir;
  beforeEach(() => {
    h = mk();
    dir = mkdtempSync(join(tmpdir(), "aice-memexp-"));
  });
  afterEach(() => {
    h.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("exports a contained, redacted, bounded JSON payload + audits", () => {
    h.svc.set({ scope: "project", projectId: "P", key: "arch", value: "sqlite", actor: "t" });
    // Belt+braces: a row planted below the service layer still gets redacted on export.
    h.entries.upsert({
      scope: "project",
      projectId: "P",
      key: "planted",
      valueJson: JSON.stringify(`token=${FAKE_TOKEN}`),
      createdBy: "fixture",
    });
    const res = h.svc.exportPartition({ scope: "project", projectId: "P" }, join(dir, "out.json"), dir, "t");
    assert.equal(res.count, 2);
    const doc = JSON.parse(readFileSync(res.file, "utf8"));
    assert.equal(doc.format, "aice-memory-export/v1");
    const planted = doc.entries.find((e) => e.key === "planted");
    assert.ok(!planted.value.includes(FAKE_TOKEN), "export re-redacts planted rows");
    assert.ok(/redacted/i.test(planted.value), "redaction token present");
    assert.ok(h.audits.some((e) => e.action === "memory.export" && e.decision === "allow"));
  });

  it("refuses export outside the jail (fail closed, error names escape)", () => {
    assert.throws(
      () => h.svc.exportPartition({ scope: "global" }, join(dir, "..", "escape-TESTONLY.json"), dir, "t"),
      (err) => err.code === "ESCAPE",
    );
    assert.equal(existsSync(join(dir, "..", "escape-TESTONLY.json")), false);
  });

  it("refuses empty export path", () => {
    assert.throws(() => h.svc.exportPartition({ scope: "global" }, "  ", dir, "t"), /required/);
  });
});
