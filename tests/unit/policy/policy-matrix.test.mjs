// Policy matrix — Plan §8/§33, P3.5. One declarative row per decision point, mirroring
// the exact ToolRequest shapes each tool's preflight emits (packages/tools/src/*).
// If a tool's preflight changes, this matrix is the contract that calls it out.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../../../packages/policy/src/index.ts";

/** Full-grant baseline (operator-scale agent). Rows override individual knobs. */
const G = (over = {}) => ({
  toolsAllow: ["*"],
  toolsDeny: [],
  fsRead: "workspace",
  fsWrite: "workspace",
  terminal: "approved_commands",
  networkDefault: "deny",
  networkAllow: [],
  maxRisk: "high",
  maxClassification: "confidential",
  ...over,
});
const C = (over = {}) => ({ workspaceLocked: false, providerMaxClassification: "confidential", ...over });
/** Request baseline mirrors call-level defaults; rows override. */
const R = (over = {}) => ({
  tool: "t.x",
  risk: "medium",
  classification: "public",
  dangerous: false,
  neverAllow: false,
  ...over,
});

/** name, request, grantOv, ctxOv, expect, [reason regex] */
const ROWS = [
  // fs.read → preflight { fsReadScope: "workspace" } at low risk
  ["fs.read allows with fsRead=workspace", R({ tool: "fs.read", risk: "low", fsReadScope: "workspace" }), {}, {}, "allow"],
  ["fs.read denied fsRead=none", R({ tool: "fs.read", risk: "low", fsReadScope: "workspace" }), { fsRead: "none" }, {}, "deny", /read scope/],
  ["fs.read allowed fsRead=project (superset)", R({ tool: "fs.read", risk: "low", fsReadScope: "workspace" }), { fsRead: "project" }, {}, "allow"],

  // fs.write → new file; overwrite/secret → dangerous
  ["fs.write new file allows", R({ tool: "fs.write", fsScope: "workspace" }), {}, {}, "allow"],
  ["fs.write denied fsWrite=none", R({ tool: "fs.write", fsScope: "workspace" }), { fsWrite: "none" }, {}, "deny"],
  ["fs.write overwrite gates approval", R({ tool: "fs.write", fsScope: "workspace", dangerous: true }), {}, {}, "approval"],
  ["fs.write overwrite allowed with evidence", R({ tool: "fs.write", fsScope: "workspace", dangerous: true, approved: true }), {}, {}, "allow"],
  ["fs.write escape hard-denies even approved", R({ tool: "fs.write", fsScope: "workspace", dangerous: true, neverAllow: true, approved: true }), {}, {}, "deny", /never allowed/],

  // fs.edit → always dangerous
  ["fs.edit gates approval", R({ tool: "fs.edit", fsScope: "workspace", dangerous: true }), {}, {}, "approval"],
  ["fs.edit runs with evidence", R({ tool: "fs.edit", fsScope: "workspace", dangerous: true, approved: true }), {}, {}, "allow"],

  // terminal.exec → classifier risk flows; shapes dictate neverAllow
  ["terminal.echo allows (terminal approved_commands)", R({ tool: "terminal.exec", fsScope: "workspace" }), {}, {}, "allow"],
  ["terminal.* DENIED when terminal=none (medium risk)", R({ tool: "terminal.exec", fsScope: "workspace" }), { terminal: "none" }, {}, "deny", /terminal not granted/],
  ["terminal sudo-like gates approval", R({ tool: "terminal.exec", fsScope: "workspace", risk: "high", dangerous: true }), {}, {}, "approval"],
  ["terminal rm -rf / hard-denies even approved + full", R({ tool: "terminal.exec", fsScope: "workspace", risk: "high", dangerous: true, neverAllow: true, approved: true }), { terminal: "full" }, {}, "deny"],

  // git.exec → read-only low; mutating dangerous
  ["git status allows even maxRisk=low", R({ tool: "git.exec", risk: "low", fsScope: "workspace" }), { maxRisk: "low" }, {}, "allow"],
  ["git commit gates approval", R({ tool: "git.exec", risk: "medium", fsScope: "workspace", dangerous: true }), {}, {}, "approval"],
  ["git force-push hard-denies always", R({ tool: "git.exec", risk: "high", fsScope: "workspace", dangerous: true, neverAllow: true, approved: true }), {}, {}, "deny"],

  // test.exec → stack allowlisted medium
  ["test.exec node allows", R({ tool: "test.exec", fsScope: "workspace" }), {}, {}, "allow"],
  ["test.exec unknown stack hard-denies", R({ tool: "test.exec", fsScope: "workspace", dangerous: true, neverAllow: true, approved: true }), {}, {}, "deny"],

  // scan.exec → medium, reads tree
  ["scan.exec allows with allowlist", R({ tool: "scan.exec", fsScope: "workspace" }), {}, {}, "allow"],
  ["scan.exec denied when tool missing from grant", R({ tool: "scan.exec", fsScope: "workspace" }), { toolsAllow: ["fs.read"] }, {}, "deny", /not granted/],
  ["scan.exec denied via toolsDeny pin", R({ tool: "scan.exec", fsScope: "workspace" }), { toolsDeny: ["scan.exec"] }, {}, "deny"],

  // browser.fetch → networkHost flows
  ["browser.fetch listed host allows", R({ tool: "browser.fetch", networkHost: "example.com" }), { networkAllow: ["example.com"] }, {}, "allow"],
  ["browser.fetch unlisted host default-deny", R({ tool: "browser.fetch", networkHost: "exfil.TESTONLY.invalid" }), {}, {}, "deny", /network host/],
  ["browser.fetch default-allow regime allows public", R({ tool: "browser.fetch", networkHost: "exfil.TESTONLY.invalid" }), { networkDefault: "allow" }, {}, "allow"],
  ["browser.fetch gate-flag neverAllow hard-denies (creds/scheme)", R({ tool: "browser.fetch", networkHost: "invalid.invalid", neverAllow: true }), { networkDefault: "allow" }, {}, "deny"],

  // generic invariants
  ["deny-by-default: unknown-tool id vs exact allowlist", R({ tool: "t.x" }), { toolsAllow: ["t.y"] }, {}, "deny"],
  ["workspaceLocked denies everything (even approved)", R({ tool: "fs.read", risk: "low", approved: true }), {}, { workspaceLocked: true }, "deny", /workspace locked/],
  ["classification above agent clearance denies", R({ tool: "fs.read", risk: "low", fsReadScope: "workspace", classification: "restricted" }), { maxClassification: "confidential" }, {}, "deny"],
  ["classification above provider clearance denies", R({ tool: "browser.fetch", networkHost: "example.com", classification: "confidential" }), { networkAllow: ["example.com"] }, { providerMaxClassification: "internal" }, "deny"],
  ["high-risk medium-grant gates approval without evidence", R({ tool: "terminal.exec", risk: "high", fsScope: "workspace" }), {}, {}, "approval"],
  ["approved evidence does not bypass toolsAllow deny", R({ tool: "fs.write", fsScope: "workspace", dangerous: true, approved: true }), { toolsAllow: ["fs.read"] }, {}, "deny"],
];

describe("policy decision matrix (P3.5 contract)", () => {
  for (const [name, request, grantOv, ctxOv, expect, reasonRe] of ROWS) {
    it(`${name} → ${expect}`, () => {
      const verdict = evaluate(request, G(grantOv), C(ctxOv));
      assert.equal(
        verdict.decision,
        expect,
        `${name}: got ${verdict.decision} reasons=${verdict.reasons.join("; ")}`,
      );
      if (reasonRe !== undefined) {
        assert.match(verdict.reasons.join("; "), reasonRe, `${name}: reason text`);
      }
    });
  }

  it("matrix stays honest: every row names a concrete tool or exercises a generic invariant", () => {
    const named = new Set(ROWS.map((r) => r[1].tool));
    for (const t of ["fs.read", "fs.write", "fs.edit", "terminal.exec", "git.exec", "test.exec", "scan.exec", "browser.fetch"]) {
      assert.ok(named.has(t), `matrix covers ${t}`);
    }
  });
});
