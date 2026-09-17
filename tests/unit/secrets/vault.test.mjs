// Unit: vault handle discipline (MemoryVault = test double only).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MemoryVault, secretRef, secretValue, last4Of } from "../../../packages/secrets/src/index.ts";

describe("MemoryVault", () => {
  it("stores/loads/rotates/deletes by handle", async () => {
    const v = new MemoryVault();
    const ref = secretRef("vault://providers/TESTONLY/key");
    await v.store(ref, secretValue("TESTONLY-value-1234"));
    assert.equal(await v.has(ref), true);
    const loaded = await v.load(ref);
    assert.equal(String(loaded), "TESTONLY-value-1234");
    await v.rotate(ref, secretValue("TESTONLY-value-5678"));
    assert.equal(String(await v.load(ref)), "TESTONLY-value-5678");
    await v.delete(ref);
    assert.equal(await v.has(ref), false);
  });

  it("describe() exposes last4 only, never the value", async () => {
    const v = new MemoryVault();
    const ref = secretRef("vault://providers/TESTONLY/key");
    await v.store(ref, secretValue("TESTONLY-value-9999"));
    const meta = await v.describe(ref);
    assert.equal(meta.last4, "9999");
    assert.ok(!JSON.stringify(meta).includes("TESTONLY-value"));
  });

  it("rejects bad refs and missing entries", async () => {
    assert.throws(() => secretRef("providers/x"), /vault:\/\//);
    const v = new MemoryVault();
    await assert.rejects(() => v.load(secretRef("vault://missing")), /no secret/);
  });

  it("last4 masks short values", () => {
    assert.equal(last4Of(secretValue("TESTONLY-abcdef")), "cdef");
  });
});
