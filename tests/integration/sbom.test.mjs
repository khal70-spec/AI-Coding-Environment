// Phase 10: SBOM lane — CycloneDX document validity + policy cross-checks.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));

function generate(work) {
  const target = join(work, "sbom.json");
  execFileSync(process.execPath, ["scripts/sbom-generate.mjs", "--out", target], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  return JSON.parse(readFileSync(target, "utf8"));
}

test("sbom: valid CycloneDX 1.5 skeleton", () => {
  const work = mkdtempSync(join(tmpdir(), "aice-sbom-"));
  try {
    const bom = generate(work);
    assert.equal(bom.bomFormat, "CycloneDX");
    assert.equal(bom.specVersion, "1.5");
    assert.ok(Array.isArray(bom.components) && bom.components.length > 0);
    assert.equal(bom.metadata.component.name, rootPkg.name);
    assert.equal(bom.metadata.component.version, rootPkg.version);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test("sbom: component set == workspace manifests + every locked third-party dep, hashes carried", () => {
  const work = mkdtempSync(join(tmpdir(), "aice-sbom-"));
  try {
    const bom = generate(work);
    const workspace = bom.components.filter((c) => c.properties?.some((pr) => pr.name === "workspace:path"));
    const lockedThirdParty = Object.keys(lock.packages).filter((k) => k.startsWith("node_modules/") && !k.includes("@ai-coding-env/")).length;
    const thirdParty = bom.components.filter((c) => !workspace.includes(c));
    assert.ok(workspace.length >= 13);                                  // full package set
    assert.equal(thirdParty.length, lockedThirdParty);                  // no phantom deps
    assert.equal(bom.components.length, workspace.length + thirdParty.length);
    for (const c of thirdParty) {
      assert.ok(Array.isArray(c.hashes) && c.hashes[0].alg === "SHA-512", c.name);
    }
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test("sbom: zero runtime-lane components (matches supply-chain R1)", () => {
  const work = mkdtempSync(join(tmpdir(), "aice-sbom-"));
  try {
    const bom = generate(work);
    const runtime = bom.components.filter(
      (c) => c.properties?.some((pr) => pr.name === "cdx:npm:development" && pr.value === "false"),
    );
    assert.equal(runtime.length, 0);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test("sbom: deterministic output (byte-identical regeneration)", () => {
  const work = mkdtempSync(join(tmpdir(), "aice-sbom-"));
  try {
    const a = generate(work);
    const b = generate(work);
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  } finally { rmSync(work, { recursive: true, force: true }); }
});
