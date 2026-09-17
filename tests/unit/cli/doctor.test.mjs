// Unit: CLI smoke (version/help/doctor), offline.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "apps/cli/src/cli.ts");
const SRC_VERSION = /const VERSION = "([^"]+)"/.exec(readFileSync(CLI, "utf8"))?.[1];

describe("aice cli", () => {
  it("prints version", () => {
    const out = execFileSync(process.execPath, [CLI, "version"], { encoding: "utf8" });
    assert.ok(SRC_VERSION !== undefined && SRC_VERSION !== "", "VERSION const is parseable");
    assert.equal(out.trim(), SRC_VERSION);
  });

  it("doctor passes on a healthy checkout", () => {
    const out = execFileSync(process.execPath, [CLI, "doctor"], { encoding: "utf8" });
    assert.ok(out.includes("OK"));
    assert.ok(!out.includes("MISSING"));
  });
});
