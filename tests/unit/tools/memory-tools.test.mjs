// Unit: memory.read / memory.write through the ToolRunner (Plan §25 + §18):
// registered tools, schema funnel, policy gating per manifest (orchestrator only),
// secret refusal surfaces as POLICY_DENIED, outputs stay trust-tagged + capped.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ToolRunner } from "../../../packages/tools/src/runtime.ts";
import { createMemoryTools } from "../../../packages/tools/src/memory-tools.ts";
import {
  applyMigrations,
  defaultMigrationsDir,
  MemoryEntriesDao,
  MemoryRetentionDao,
} from "../../../packages/storage/src/index.ts";
import { MemoryService } from "../../../packages/memory/src/index.ts";
import { BUILTIN_MANIFESTS } from "../../../packages/agents/src/index.ts";

const FAKE_TOKEN = ["g", "h", "p_"].join("") + "A".repeat(24) + "-TESTONLY";
const PCTX = { workspaceLocked: false, providerMaxClassification: "restricted" };

function untag(output) {
  return output.split("\n").slice(1, -1).join("\n");
}

describe("memory tools via ToolRunner (policy funnel)", () => {
  let db;
  let runner;
  let jail;
  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    applyMigrations(db, defaultMigrationsDir());
    const svc = new MemoryService({
      entries: new MemoryEntriesDao(db),
      retention: new MemoryRetentionDao(db),
    });
    runner = new ToolRunner(createMemoryTools(svc));
    jail = mkdtempSync(join(tmpdir(), "aice-memtool-"));
  });
  afterEach(() => {
    db.close();
    rmSync(jail, { recursive: true, force: true });
  });

  function ctx(grant) {
    return {
      actor: "agent:orchestrator",
      risk: "medium",
      classification: "internal",
      grant,
      policyCtx: PCTX,
      jailRoot: jail,
    };
  }
  const call = (tool, args) => ({ tool, args, cwd: jail, risk: "medium", classification: "internal" });

  it("registers both tools and lists them on the surface", () => {
    assert.deepEqual(runner.ids(), ["memory.read", "memory.write"]);
    assert.match(runner.describe("memory.read"), /scope!:string/);
  });

  it("orchestrator grant: write then read round-trip (trust-tagged output)", async () => {
    const grant = BUILTIN_MANIFESTS.orchestrator.grant;
    const w = await runner.call(call("memory.write", { scope: "project", projectId: "P1", key: "arch", value: "sqlite-wal" }), ctx(grant));
    assert.equal(w.ok, true, w.output);
    assert.match(untag(w.output), /memory\.write ok scope=project key=arch/);
    const r = await runner.call(call("memory.read", { scope: "project", projectId: "P1", key: "arch" }), ctx(grant));
    assert.equal(r.ok, true);
    const body = JSON.parse(untag(r.output));
    assert.equal(body.found, true);
    assert.equal(JSON.parse(body.entry.valueJson), "sqlite-wal");
  });

  it("implementer grant has NO memory grant → POLICY_DENIED before execution", async () => {
    const granted = BUILTIN_MANIFESTS.implementer.grant;
    const res = await runner.call(call("memory.write", { scope: "global", key: "k", value: "v" }), ctx(granted));
    assert.equal(res.ok, false);
    assert.equal(res.code, "POLICY_DENIED");
    const after = await runner.call(call("memory.read", { scope: "global" }), ctx(granted));
    assert.equal(after.code, "POLICY_DENIED");
    // nothing landed (policy stopped the write before the service ran)
    const orch = BUILTIN_MANIFESTS.orchestrator.grant;
    const list = await runner.call(call("memory.read", { scope: "global" }), ctx(orch));
    assert.equal(JSON.parse(untag(list.output)).count, 0);
  });

  it("secret-shaped value → POLICY_DENIED (service refusal), never stored", async () => {
    const grant = BUILTIN_MANIFESTS.orchestrator.grant;
    const res = await runner.call(call("memory.write", { scope: "global", key: "k", value: FAKE_TOKEN }), ctx(grant));
    assert.equal(res.ok, false);
    assert.equal(res.code, "POLICY_DENIED");
    assert.match(res.output, /looks like a secret/);
    const list = await runner.call(call("memory.read", { scope: "global" }), ctx(grant));
    assert.equal(JSON.parse(untag(list.output)).count, 0);
  });

  it("unknown scope → VALIDATION_ERROR; unknown args are rejected by the schema", async () => {
    const grant = BUILTIN_MANIFESTS.orchestrator.grant;
    const bad = await runner.call(call("memory.write", { scope: "nope", key: "k", value: "v" }), ctx(grant));
    assert.equal(bad.code, "VALIDATION_ERROR");
    const extra = await runner.call(call("memory.read", { scope: "global", hackerino: "y" }), ctx(grant));
    assert.equal(extra.code, "VALIDATION_ERROR");
    assert.match(extra.output, /unknown arg/);
  });

  it("scope contract: global with projectId → VALIDATION_ERROR (isolation contract)", async () => {
    const grant = BUILTIN_MANIFESTS.orchestrator.grant;
    const res = await runner.call(call("memory.write", { scope: "global", projectId: "P1", key: "k", value: "v" }), ctx(grant));
    assert.equal(res.code, "VALIDATION_ERROR");
    assert.match(res.output, /not allowed for scope global/);
  });
});
