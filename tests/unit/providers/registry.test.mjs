// Unit: model registry (config, not architecture).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InMemoryRegistry, emptyCapabilities } from "../../../packages/providers/src/index.ts";

function model(over = {}) {
  const caps = emptyCapabilities();
  caps.text = true;
  return {
    id: "TESTONLY/mock-1", providerId: "TESTONLY-local", displayName: "Mock",
    capabilities: caps, contextWindow: 8192,
    declaredCapabilitiesVerified: true, status: "available", ...over,
  };
}

describe("registry", () => {
  it("registers and lists models", () => {
    const r = new InMemoryRegistry();
    r.register(model());
    assert.equal(r.list().length, 1);
    assert.equal(r.get("TESTONLY/mock-1")?.contextWindow, 8192);
  });

  it("marks unverified models until capability tests pass", () => {
    const r = new InMemoryRegistry();
    r.register(model({ id: "TESTONLY/mock-2", declaredCapabilitiesVerified: false }));
    assert.equal(r.get("TESTONLY/mock-2")?.status, "unverified");
    assert.equal(r.listByCapability("text").length, 0);
  });

  it("filters by capability + availability", () => {
    const r = new InMemoryRegistry();
    r.register(model());
    assert.equal(r.listByCapability("vision").length, 0);
    assert.equal(r.listByCapability("text").length, 1);
    r.setStatus("TESTONLY/mock-1", "unavailable");
    assert.equal(r.listByCapability("text").length, 0);
  });

  it("rejects invalid records", () => {
    const r = new InMemoryRegistry();
    assert.throws(() => r.register(model({ id: "" })), /model id/);
    assert.throws(() => r.setStatus("nope", "available"), /unknown model/);
  });
});
