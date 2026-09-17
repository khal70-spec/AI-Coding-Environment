// Unit: sandbox capability detection (P3.2 level-2 markers). PATH-based, no exec.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { detectSandbox, findOnPath, sandboxMarker } from "../../../packages/tools/src/sandbox-detect.ts";

function fakeBin(name) {
  const dir = mkdtempSync(join(tmpdir(), "aice-sbox-"));
  const p = join(dir, name);
  writeFileSync(p, "#!/bin/sh\nexit 0\n");
  chmodSync(p, 0o755);
  return { dir, p };
}

describe("sandbox detection", () => {
  it("findOnPath locates executables in explicit dirs only", () => {
    const { dir } = fakeBin("bwrap-aice-fixture-TESTONLY");
    const found = findOnPath("bwrap-aice-fixture-TESTONLY", ["/nonexistent-aice", dir]);
    assert.ok(found !== null && found.endsWith("bwrap-aice-fixture-TESTONLY"));
    assert.equal(findOnPath("bwrap-aice-fixture-TESTONLY", ["/nonexistent-aice"]), null);
  });

  it("reports level 2 when bwrap/firejail appear on PATH", () => {
    const { dir } = fakeBin("bwrap");
    const report = detectSandbox({ PATH: dir, container: undefined, FLATPAK_ID: undefined });
    assert.equal(report.maxLevel, 2);
    assert.ok(report.bwrap !== null);
    assert.match(sandboxMarker(report), /sandbox-level-2/);
  });

  it("reports level 1 otherwise and carries container markers", () => {
    const empty = mkdtempSync(join(tmpdir(), "aice-sbox-empty-"));
    const sep = delimiter;
    const report = detectSandbox({ PATH: empty, container: "podman" });
    assert.ok(report.scannedPathDirs.length >= 1 && report.scannedPathDirs[0] === empty && sep !== "");
    assert.equal(report.maxLevel, 1);
    assert.equal(report.containerized, true);
    assert.match(sandboxMarker(report), /sandbox-level-1 container/);
  });

  it("ignores unreadable/relative PATH entries without throwing", () => {
    const report = detectSandbox({ PATH: ["relative-dir", "/definitely/missing-aice"].join(delimiter) });
    assert.equal(report.maxLevel, 1);
  });
});
