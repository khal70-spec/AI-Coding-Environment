// Unit: core state machine (ADR-007). Every edge + terminal + illegal jumps.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TRANSITIONS, canTransition, isTerminal, classificationAllowed, riskAtLeast } from "../../../packages/core/src/index.ts";

describe("state machine", () => {
  it("walks the full happy path", () => {
    const path = ["CREATED","CLASSIFYING","INVESTIGATING","PLANNING","WAITING_APPROVAL","PREPARING_WORKSPACE","IMPLEMENTING","TESTING","SECURITY_REVIEW","AI_REVIEW","VERIFYING","READY","APPROVED","MERGED"];
    for (let i = 0; i < path.length - 1; i++) assert.equal(canTransition(path[i], path[i+1]), true, `${path[i]} → ${path[i+1]}`);
  });

  it("supports fix loops back through verify", () => {
    assert.equal(canTransition("TESTING", "FIXING"), true);
    assert.equal(canTransition("SECURITY_REVIEW", "FIXING"), true);
    assert.equal(canTransition("AI_REVIEW", "FIXING"), true);
    assert.equal(canTransition("VERIFYING", "FIXING"), true);
    assert.equal(canTransition("FIXING", "IMPLEMENTING"), true);
  });

  it("denies skipped verification", () => {
    assert.equal(canTransition("IMPLEMENTING", "MERGED"), false);
    assert.equal(canTransition("CREATED", "APPROVED"), false);
    assert.equal(canTransition("TESTING", "APPROVED"), false);
    assert.equal(canTransition("PLANNING", "IMPLEMENTING"), false);
  });

  it("exposes failure exits and rollback path", () => {
    assert.equal(canTransition("IMPLEMENTING", "FAILED"), true);
    assert.equal(canTransition("FAILED", "ROLLBACK_REQUIRED"), true);
    assert.equal(canTransition("ROLLBACK_REQUIRED", "FAILED"), true);
    assert.equal(canTransition("BLOCKED", "INVESTIGATING"), true);
  });

  it("marks terminals", () => {
    assert.equal(isTerminal("MERGED"), true);
    assert.equal(isTerminal("CANCELLED"), true);
    assert.equal(isTerminal("FAILED"), true);
    assert.equal(isTerminal("READY"), false);
  });

  it("every non-terminal state has at least one exit", () => {
    for (const [state, exits] of Object.entries(TRANSITIONS)) {
      if (!isTerminal(state)) assert.ok(exits.length > 0, state);
    }
  });
});

describe("risk + classification helpers", () => {
  it("orders risk", () => {
    assert.equal(riskAtLeast("high", "medium"), true);
    assert.equal(riskAtLeast("low", "medium"), false);
    assert.equal(riskAtLeast("medium", "medium"), true);
  });

  it("gates classification strictly", () => {
    assert.equal(classificationAllowed("internal", "internal"), true);
    assert.equal(classificationAllowed("restricted", "internal"), false); // never declassify
    assert.equal(classificationAllowed("public", "restricted"), true);
  });
});
