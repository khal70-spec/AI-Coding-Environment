// Security gate (P8.1): fail-loud proof. Every blocking lane must return non-zero
// with named evidence when its invariant is tripped, and the composed gate must
// exit 1 — never a "has no findings while a violation is live" placebo. Plants are
// reversible (git index / file system restored in try/finally, always).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const NODE = process.execPath;

function run(script, timeout = 300_000) {
  return spawnSync(NODE, [join(ROOT, "scripts", script)], { cwd: ROOT, encoding: "utf8", timeout, shell: false });
}

describe("security gate lanes: fail-loud on live violations", () => {
  it("SAST: planted eval is found, named, and fails the lane; cleanup restores green", { timeout: 60_000 }, () => {
    const plant = join(ROOT, "packages", "security", "src", "zz-sast-evil-TESTONLY.ts");
    writeFileSync(plant, '// gate-test plant (auto-deleted)\nexport const evil = eval("1+1");\n');
    try {
      const bad = run("security-sast.mjs");
      assert.equal(bad.status, 1, `SAST did NOT fail on a live eval (status=${bad.status})`);
      assert.match(bad.stdout + bad.stderr, /S1/);
      assert.match(bad.stdout + bad.stderr, /zz-sast-evil-TESTONLY\.ts/);
    } finally {
      rmSync(plant, { force: true });
    }
    const good = run("security-sast.mjs");
    assert.equal(good.status, 0, `SAST not green after cleanup: ${good.stderr}`);
  });

  it("SAST: planted XSS sink in apps/desktop/web is found (S6)", { timeout: 60_000 }, () => {
    const plant = join(ROOT, "apps", "desktop", "web", "zz-xss-TESTONLY.js");
    writeFileSync(plant, "// gate-test plant (auto-deleted)\ndocument.body.innerHTML = \"<img>\";\n");
    try {
      const bad = run("security-sast.mjs");
      assert.equal(bad.status, 1);
      assert.match(bad.stdout, /S6/);
    } finally {
      rmSync(plant, { force: true });
    }
  });

  it("secrets lane: planted token in a TRACKED file fails; untracked plant is not silently accepted", { timeout: 300_000 }, () => {
    const plant = join(ROOT, "zz-leak-TESTONLY.txt");
    writeFileSync(plant, "token: ghp_qc8ZyNoeGkRbLdMfAvXsTwHuJiCfKB1234567\n");
    // tracked-only lane requires git index membership — stage, scan, unstage:
    const tracked = spawnSync("git", ["add", plant], { cwd: ROOT, shell: false });
    assert.equal(tracked.status, 0);
    try {
      const bad = run("check-secrets.mjs");
      assert.equal(bad.status, 1, `secrets lane did NOT fail on a live token (status=${bad.status})`);
      assert.match(bad.stdout + bad.stderr, /zz-leak-TESTONLY\.txt|github-token|probable secret/i);
    } finally {
      rmSync(plant, { force: true });
      spawnSync("git", ["rm", "--cached", "--ignore-unmatch", "zz-leak-TESTONLY.txt"], { cwd: ROOT, shell: false, stdio: "ignore" });
    }
    const good = run("check-secrets.mjs");
    assert.equal(good.status, 0, `secrets lane not green after cleanup: ${good.stdout}`);
  });

  it("supply-chain: a runtime dep in a workspace package is R1-denied and restored", { timeout: 60_000 }, () => {
    const pkgPath = join(ROOT, "packages", "security", "package.json");
    const original = readFileSync(pkgPath, "utf8");
    const mutated = JSON.parse(original);
    mutated.dependencies = { "evil-pony": "^9000.0.1" };
    writeFileSync(pkgPath, JSON.stringify(mutated, null, 2) + "\n");
    try {
      const bad = run("supply-chain-check.mjs");
      assert.equal(bad.status, 1);
      assert.match(bad.stdout, /R1/);
      assert.match(bad.stdout, /evil-pony/);
    } finally {
      writeFileSync(pkgPath, original);
      spawnSync("git", ["checkout", "--", "packages/security/package.json"], { cwd: ROOT, shell: false, stdio: "ignore" });
    }
    const good = run("supply-chain-check.mjs");
    assert.equal(good.status, 0);
  });

  it("supply-chain: a caret-pinned devDep is R2-denied", { timeout: 60_000 }, () => {
    const pkgPath = join(ROOT, "packages", "core", "package.json");
    const original = readFileSync(pkgPath, "utf8");
    const mutated = JSON.parse(original);
    mutated.devDependencies = { eslint: "^9.0.0" };
    writeFileSync(pkgPath, JSON.stringify(mutated, null, 2) + "\n");
    try {
      const bad = run("supply-chain-check.mjs");
      assert.equal(bad.status, 1);
      assert.match(bad.stdout, /R2/);
    } finally {
      writeFileSync(pkgPath, original);
    }
  });

  it("composed gate exits 1 with the offending lane named when any lane trips", { timeout: 300_000 }, () => {
    const plant = join(ROOT, "packages", "security", "src", "zz-sast-evil-TESTONLY.ts");
    writeFileSync(plant, '// gate-test plant (auto-deleted)\ncosnt x = new Function("return 1")();\n'.replace("cosnt", "const"));
    try {
      const gate = spawnSync(NODE, [join(ROOT, "scripts", "security-gate.mjs")], { cwd: ROOT, encoding: "utf8", timeout: 300_000, shell: false });
      assert.equal(gate.status, 1, `gate did not fail with a live violation: ${gate.stdout}`);
      assert.match(gate.stdout, /sast-lite\s+FAIL/);
      assert.match(gate.stderr, /SECURITY GATE: FAIL/);
    } finally {
      rmSync(plant, { force: true });
    }
    const good = run("security-gate.mjs", 300_000);
    assert.equal(good.status, 0, `gate not green after cleanup:\n${good.stdout}\n${good.stderr}`);
    assert.match(good.stdout, /SECURITY GATE: GREEN/);
  });
});
