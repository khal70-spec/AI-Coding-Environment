// Unit: command classifier — benign vs risky argv.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyCommand, looksLikeRawShell } from "../../../packages/security/src/index.ts";

describe("classifyCommand", () => {
  it("rates read-only inspection low", () => {
    assert.equal(classifyCommand(["git", "status"]).risk, "low");
    assert.equal(classifyCommand(["ls", "-la"]).risk, "low");
  });

  it("blocks destructive shapes", () => {
    assert.equal(classifyCommand(["rm", "-rf", "/"]).risk, "blocked");
    assert.equal(classifyCommand(["git", "push", "--force"]).risk, "blocked");
    assert.equal(classifyCommand(["git", "reset", "--hard"]).risk, "blocked");
    assert.equal(classifyCommand(["psql", "-c", "DROP DATABASE app"]).risk, "blocked");
  });

  it("elevates infra/cloud and sudo", () => {
    assert.equal(classifyCommand(["sudo", "ls"]).risk, "high");
    assert.equal(classifyCommand(["kubectl", "get", "pods"]).risk, "high");
    assert.equal(classifyCommand(["npm", "install"]).risk, "medium");
  });

  it("defaults unknown commands to medium (never low)", () => {
    assert.equal(classifyCommand(["some-obscure-tool", "--x"]).risk, "medium");
  });

  it("detects raw shell strings", () => {
    assert.equal(looksLikeRawShell("ls -la"), false);
    assert.equal(looksLikeRawShell("ls; rm -rf /"), true);
    assert.equal(looksLikeRawShell("$(whoami)"), true);
  });
});
