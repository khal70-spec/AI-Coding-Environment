// Security T13/T14: confused-deputy / escalation attempts MUST be denied.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../../packages/policy/src/index.ts";
import { BUILTIN_MANIFESTS, validateManifest } from "../../packages/agents/src/index.ts";

const ctx = { workspaceLocked: false, providerMaxClassification: "internal" };

describe("permission bypass", () => {
  it("investigator cannot write or run terminals", () => {
    const inv = BUILTIN_MANIFESTS.investigator.grant;
    const base = { risk: "low", classification: "internal", dangerous: false, neverAllow: false };
    assert.equal(evaluate({ ...base, tool: "fs.write" }, inv, ctx).decision, "deny");
    assert.equal(evaluate({ ...base, tool: "terminal.run" }, inv, ctx).decision, "deny");
    assert.equal(evaluate({ ...base, tool: "fs.read" }, inv, ctx).decision, "allow");
  });

  it("implementer cannot reach project-wide write or network", () => {
    const impl = BUILTIN_MANIFESTS.implementer.grant;
    const base = { tool: "fs.write", risk: "medium", classification: "internal", dangerous: false, neverAllow: false };
    assert.equal(evaluate({ ...base, fsScope: "project" }, impl, ctx).decision, "deny");
    assert.equal(evaluate({ ...base, fsScope: "workspace" }, impl, ctx).decision, "allow");
    assert.equal(evaluate({ ...base, tool: "mcp.call", networkHost: "api.github.com" }, impl, ctx).decision, "deny");
  });

  it("wildcard tool smuggling fails manifest validation", () => {
    const m = BUILTIN_MANIFESTS.tester;
    const evil = { ...m, grant: { ...m.grant, toolsAllow: [...m.grant.toolsAllow, "*"] } };
    assert.ok(validateManifest(evil).length > 0);
  });

  it("terminal-full smuggling fails manifest validation", () => {
    const m = BUILTIN_MANIFESTS.implementer;
    const evil = { ...m, grant: { ...m.grant, terminal: "full" } };
    assert.ok(validateManifest(evil).some((e) => e.includes("terminal")));
  });

  it("restricted context cannot flow to an internal-cleared provider", () => {
    const sec = BUILTIN_MANIFESTS["security-reviewer"].grant; // agent cleared…
    const v = evaluate(
      { tool: "fs.read", risk: "low", classification: "restricted", dangerous: false, neverAllow: false },
      sec, ctx, // …but provider path is not
    );
    assert.equal(v.decision, "deny");
  });
});
