// Unit: built-in manifests validate; bad manifests rejected.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_MANIFESTS, validateManifest } from "../../../packages/agents/src/index.ts";

describe("manifests", () => {
  it("all built-ins are valid", () => {
    for (const m of Object.values(BUILTIN_MANIFESTS)) {
      assert.deepEqual([...validateManifest(m)], [], m.agent);
    }
  });

  it("investigator is read-only", () => {
    const inv = BUILTIN_MANIFESTS.investigator;
    assert.equal(inv.grant.fsWrite, "none");
    assert.equal(inv.grant.terminal, "none");
    assert.ok(!inv.grant.toolsAllow.includes("fs.write"));
  });

  it("rejects wildcard/full/network-allow/project-write", () => {
    const base = BUILTIN_MANIFESTS.implementer;
    assert.ok(validateManifest({ ...base, grant: { ...base.grant, toolsAllow: ["*"] } }).length > 0);
    assert.ok(validateManifest({ ...base, grant: { ...base.grant, terminal: "full" } }).length > 0);
    assert.ok(validateManifest({ ...base, grant: { ...base.grant, networkDefault: "allow" } }).length > 0);
    assert.ok(validateManifest({ ...base, grant: { ...base.grant, fsWrite: "project" } }).length > 0);
    assert.ok(validateManifest({ ...base, grant: { ...base.grant, toolsAllow: ["nope.tool"] } }).length > 0);
  });
});
