// Unit: tool kernel — registry deny-by-default, schema, policy funnel, jail gate,
// redaction, byte cap, trust tagging, timeout, audit (keys-only).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRunner, TOOL_MAX_OUTPUT_BYTES } from "../../../packages/tools/src/runtime.ts";
import { fsRead } from "../../../packages/tools/src/fs-tools.ts";

const NUL = String.fromCharCode(0);
const FAKE_GH = ["g", "h", "p_"].join("") + "A".repeat(24) + "-TESTONLY";
const ARG_VALUE = "s3cr3t-argv-value-TESTONLY";

function untag(output) {
  const lines = output.split("\n");
  assert.ok(lines[0].startsWith("<<<UNTRUSTED-TOOL-OUTPUT"), "missing open tag");
  assert.equal(lines[lines.length - 1], "<<<END-UNTRUSTED-TOOL-OUTPUT>>>", "missing close tag");
  return lines.slice(1, -1).join("\n");
}

const GRANT = {
  toolsAllow: ["*"],
  toolsDeny: [],
  fsRead: "workspace",
  fsWrite: "workspace",
  terminal: "approved_commands",
  networkDefault: "deny",
  networkAllow: [],
  maxRisk: "high",
  maxClassification: "confidential",
};
const PCTX = { workspaceLocked: false, providerMaxClassification: "confidential" };
const ws = () => mkdtempSync(join(tmpdir(), "aice-runner-"));

function mkCtx(jailRoot, over = {}) {
  return {
    actor: "agent:tester",
    risk: "low",
    classification: "public",
    grant: GRANT,
    policyCtx: PCTX,
    jailRoot,
    ...over,
  };
}
function mkCall(tool, args, cwd, risk = "low") {
  return { tool, args, cwd, risk, classification: "public" };
}

function stub(id, opts = {}) {
  const { run = () => "ok", dangerous = false, neverAllow = false, risk = "low" } = opts;
  return {
    id,
    description: "test stub",
    defaultRisk: risk,
    argsSchema: { msg: { type: "string", maxLength: 4096 } },
    preflight: () => ({ dangerous, neverAllow }),
    run,
  };
}

describe("ToolRunner registry + schema", () => {
  it("rejects duplicate tool ids at construction", () => {
    assert.throws(() => new ToolRunner([stub("a"), stub("a")]), /duplicate tool id/);
  });

  it("deny-by-default: unknown tool id", async () => {
    const r = new ToolRunner([]);
    const res = await r.call(mkCall("nope", {}, ws()), mkCtx(ws()));
    assert.equal(res.ok, false);
    assert.equal(res.code, "TOOL_NOT_FOUND");
  });

  it("rejects unknown args (typo must not change behavior)", async () => {
    const r = new ToolRunner([stub("t.x")]);
    const res = await r.call(mkCall("t.x", { msgg: "typo" }, ws()), mkCtx(ws()));
    assert.equal(res.ok, false);
    assert.equal(res.code, "VALIDATION_ERROR");
    assert.match(String(res.reasons), /unknown arg: msgg/);
  });

  it("rejects NUL bytes in string args", async () => {
    const r = new ToolRunner([stub("t.x")]);
    const res = await r.call(mkCall("t.x", { msg: `a${NUL}b` }, ws()), mkCtx(ws()));
    assert.equal(res.ok, false);
    assert.equal(res.code, "VALIDATION_ERROR");
    assert.match(String(res.reasons), /NUL/);
  });

  it("rejects over-length string args", async () => {
    const r = new ToolRunner([stub("t.x")]);
    const res = await r.call(mkCall("t.x", { msg: "x".repeat(4097) }, ws()), mkCtx(ws()));
    assert.equal(res.code, "VALIDATION_ERROR");
  });
});

describe("ToolRunner policy funnel", () => {
  it("denies when tool not in grant.toolsAllow", async () => {
    const r = new ToolRunner([stub("t.x")]);
    const grant = { ...GRANT, toolsAllow: ["other"] };
    const res = await r.call(mkCall("t.x", {}, ws()), mkCtx(ws(), { grant }));
    assert.equal(res.ok, false);
    assert.equal(res.code, "POLICY_DENIED");
  });

  it("denies neverAllow even for full grants; tool never runs", async () => {
    let ran = 0;
    const r = new ToolRunner([stub("t.x", { neverAllow: true, run: () => ((ran += 1), "leak") })]);
    const events = [];
    const r2 = new ToolRunner([stub("t.x", { neverAllow: true, run: () => ((ran += 1), "leak") })], (e) => events.push(e));
    const res = await r2.call(mkCall("t.x", {}, ws()), mkCtx(ws()));
    assert.equal(res.ok, false);
    assert.equal(res.code, "POLICY_DENIED");
    assert.equal(ran, 0);
    assert.equal(events.at(-1).kind, "tool.call.denied");
    void r;
  });

  it("gates dangerous operations behind approval; side effects do not happen", async () => {
    let sideEffect = 0;
    const events = [];
    const r = new ToolRunner(
      [stub("t.hot", { dangerous: true, run: () => ((sideEffect += 1), "should not appear") })],
      (e) => events.push(e),
    );
    const res = await r.call(mkCall("t.hot", {}, ws()), mkCtx(ws()));
    assert.equal(res.ok, false);
    assert.equal(res.code, "APPROVAL_REQUIRED");
    assert.equal(sideEffect, 0, "gate must not execute the tool");
    assert.equal(events.at(-1).kind, "tool.call.approval_required");
  });

  it("denies on locked workspace", async () => {
    const r = new ToolRunner([stub("t.x")]);
    const res = await r.call(
      mkCall("t.x", {}, ws()),
      mkCtx(ws(), { policyCtx: { ...PCTX, workspaceLocked: true } }),
    );
    assert.equal(res.code, "POLICY_DENIED");
    assert.match(String(res.reasons), /workspace locked/);
  });
});

describe("ToolRunner execution path: tagging, audit, redaction, caps", () => {
  it("executes allowed calls: trust-tagged output + audit with arg KEYS only", async () => {
    const events = [];
    const r = new ToolRunner([stub("t.echo", { run: (args) => `echo:${String(args.msg)}` })], (e) => events.push(e));
    const res = await r.call(mkCall("t.echo", { msg: ARG_VALUE }, ws()), mkCtx(ws()));
    assert.equal(res.ok, true);
    assert.equal(untag(res.output), `echo:${ARG_VALUE}`);
    assert.ok(events.some((e) => e.kind === "tool.call.allowed"));
    const auditBlob = JSON.stringify(events);
    assert.ok(auditBlob.includes("msg"), "audit must carry arg keys");
    assert.ok(!auditBlob.includes(ARG_VALUE), "audit must never carry arg VALUES");
    assert.ok(events.at(-1).durationMs >= 0);
  });

  it("redacts secret-shaped output before tagging", async () => {
    const events = [];
    const r = new ToolRunner([stub("t.leak", { run: () => `leaked ${FAKE_GH} end` })], (e) => events.push(e));
    const res = await r.call(mkCall("t.leak", {}, ws()), mkCtx(ws()));
    const body = untag(res.output);
    assert.ok(!body.includes(FAKE_GH), "raw secret must not survive redaction");
    assert.match(body, /REDACTED/);
    assert.deepEqual(res.redactedKinds, ["github-token"]);
    assert.ok(!JSON.stringify(events).includes(FAKE_GH));
  });

  it("caps oversized output at TOOL_MAX_OUTPUT_BYTES with a marker", async () => {
    const r = new ToolRunner([stub("t.flood", { run: () => "y".repeat(300 * 1024) })]);
    const res = await r.call(mkCall("t.flood", {}, ws()), mkCtx(ws()));
    assert.equal(res.ok, true);
    assert.equal(res.code, "OUTPUT_CAPPED");
    const body = untag(res.output);
    assert.match(body, /\[output capped\]/);
    assert.ok(Buffer.byteLength(body, "utf8") <= TOOL_MAX_OUTPUT_BYTES + 64);
  });

  it("times out hung tools (min 1s) without hanging the runner", async () => {
    const r = new ToolRunner([
      stub("t.hang", { run: () => new Promise((res2) => setTimeout(() => res2("late"), 10_000)) }),
    ]);
    const jail = ws();
    const started = Date.now();
    const res = await r.call(mkCall("t.hang", {}, jail), mkCtx(jail, { defaultTimeoutMs: 25 }));
    const elapsed = Date.now() - started;
    assert.equal(res.ok, false);
    assert.equal(res.code, "TIMEOUT");
    assert.ok(elapsed < 5_000, `timeout must fire (~1s), took ${elapsed}ms`);
  });

  it("maps generic run() throws to EXECUTION_FAILED", async () => {
    const r = new ToolRunner([stub("t.boom", { run: () => { throw new Error(`kaboom ${ARG_VALUE}`); } })]);
    const res = await r.call(mkCall("t.boom", {}, ws()), mkCtx(ws()));
    assert.equal(res.ok, false);
    assert.equal(res.code, "EXECUTION_FAILED");
  });
});

describe("ToolRunner jail gate", () => {
  it("blocks fs calls whose cwd escapes the jail root", async () => {
    const root = ws();
    const events = [];
    const r = new ToolRunner([fsRead], (e) => events.push(e));
    const res = await r.call(mkCall("fs.read", { path: "." }, "/etc"), mkCtx(root));
    assert.equal(res.ok, false);
    assert.equal(res.code, "JAIL_ESCAPE");
    assert.equal(events.at(-1).kind, "tool.call.denied");
  });

  it("blocks cwd with .. segments escaping the jail root", async () => {
    const root = ws();
    const r = new ToolRunner([fsRead]);
    const res = await r.call(mkCall("fs.read", { path: "." }, join(root, "..")), mkCtx(root));
    assert.equal(res.code, "JAIL_ESCAPE");
  });
});
