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
});
