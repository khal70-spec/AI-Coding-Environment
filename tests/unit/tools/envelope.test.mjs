// Unit: tool call envelope validation.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateToolCall } from "../../../packages/tools/src/index.ts";

describe("tool envelope", () => {
  it("accepts well-formed calls", () => {
    const errs = validateToolCall({ tool: "fs.read", args: { path: "a" }, cwd: "/w", risk: "low", classification: "internal" });
    assert.equal(errs.length, 0);
  });

  it("rejects missing tool/cwd", () => {
    const errs = validateToolCall({ tool: "", args: {}, cwd: "", risk: "low", classification: "internal" });
    assert.ok(errs.length >= 2);
  });
});
