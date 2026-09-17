// Unit: context budget fitting.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fitBudget } from "../../../packages/context/src/index.ts";

const chunk = (id, tokens) => ({ id, source: `src/${id}.ts`, classification: "internal", sha256: "0".repeat(64), tokens });

describe("fitBudget", () => {
  it("keeps priority order and drops overflow", () => {
    const { kept, dropped } = fitBudget([chunk("a", 5), chunk("b", 5), chunk("c", 5)], { maxTokens: 10 });
    assert.deepEqual(kept.map((c) => c.id), ["a", "b"]);
    assert.deepEqual(dropped.map((c) => c.id), ["c"]);
  });
});
