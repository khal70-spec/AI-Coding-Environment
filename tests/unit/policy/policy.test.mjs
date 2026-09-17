// Unit: policy engine matrix (Plan §8/§18).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../../../packages/policy/src/index.ts";

const baseGrant = {
  toolsAllow: ["fs.read", "fs.write"],
  toolsDeny: [],
  fsRead: "project",
  fsWrite: "workspace",
  terminal: "none",
  networkDefault: "deny",
  networkAllow: [],
  maxRisk: "medium",
  maxClassification: "internal",
};

const ctx = { workspaceLocked: false, providerMaxClassification: "internal" };

function req(over = {}) {
  return { tool: "fs.read", risk: "low", classification: "internal", dangerous: false, neverAllow: false, ...over };
}

describe("policy engine", () => {
  it("allows in-grant low-risk calls", () => {
    const v = evaluate(req(), baseGrant, ctx);
    assert.equal(v.decision, "allow");
  });

  it("denies unlisted tools (deny by default)", () => {
    const v = evaluate(req({ tool: "terminal.run" }), baseGrant, ctx);
    assert.equal(v.decision, "deny");
  });

  it("denies explicitly denied tools", () => {
    const v = evaluate(req(), { ...baseGrant, toolsDeny: ["fs.read"] }, ctx);
    assert.equal(v.decision, "deny");
  });

  it("denies neverAllow shapes unconditionally", () => {
    const v = evaluate(req({ neverAllow: true }), { ...baseGrant, toolsAllow: ["*"] }, ctx);
    assert.equal(v.decision, "deny");
  });

  it("denies locked workspaces", () => {
    const v = evaluate(req(), baseGrant, { ...ctx, workspaceLocked: true });
    assert.equal(v.decision, "deny");
  });

  it("routes dangerous ops to approval, never allow", () => {
    const v = evaluate(req({ tool: "fs.delete", risk: "high", dangerous: true }),
      { ...baseGrant, toolsAllow: ["fs.delete"] }, ctx);
    assert.equal(v.decision, "approval");
  });

  it("routes high-risk to approval", () => {
    const v = evaluate(req({ risk: "high" }), baseGrant, ctx);
    assert.equal(v.decision, "approval");
  });

  it("denies classification above agent clearance", () => {
    const v = evaluate(req({ classification: "restricted" }), baseGrant, ctx);
    assert.equal(v.decision, "deny");
  });

  it("denies classification above provider clearance", () => {
    const v = evaluate(req({ classification: "confidential" }),
      { ...baseGrant, maxClassification: "restricted" }, ctx);
    assert.equal(v.decision, "deny");
  });

  it("denies non-allowlisted network hosts", () => {
    const g = { ...baseGrant, toolsAllow: ["mcp.call"] };
    const v = evaluate(req({ tool: "mcp.call", networkHost: "evil.TESTONLY.invalid" }), g, ctx);
    assert.equal(v.decision, "deny");
  });

  it("does not grant read scope beyond fsRead (fsReadScope vs fsRead grant)", () => {
    const g = { ...baseGrant, fsRead: "none", toolsAllow: ["fs.read"] };
    const v = evaluate(req({ tool: "fs.read", fsReadScope: "workspace" }), g, ctx);
    assert.equal(v.decision, "deny");
    assert.match(v.reasons[0], /read scope/);
  });

  it("approval evidence (approved:true) allows dangerous + high-risk only", () => {
    const vDanger = evaluate(
      req({ tool: "fs.delete", risk: "high", dangerous: true, approved: true }),
      { ...baseGrant, toolsAllow: ["fs.delete"] },
      ctx,
    );
    assert.equal(vDanger.decision, "allow");
  });

  it("approved:true does NOT bypass hard denies (neverAllow)", () => {
    const v = evaluate(
      req({ tool: "terminal.exec", neverAllow: true, approved: true }),
      { ...baseGrant, toolsAllow: ["terminal.exec"] },
      ctx,
    );
    assert.equal(v.decision, "deny");
  });

  it("approved:true does NOT bypass allowlist/scope/classification denies", () => {
    const g = { ...baseGrant, toolsAllow: [] };
    const v = evaluate(req({ tool: "fs.write", dangerous: true, approved: true }), g, ctx);
    assert.equal(v.decision, "deny");
    const gRead = { ...baseGrant, fsRead: "none", toolsAllow: ["fs.read"] };
    const v2 = evaluate(req({ tool: "fs.read", fsReadScope: "workspace", approved: true }), gRead, ctx);
    assert.equal(v2.decision, "deny");
  });
});
