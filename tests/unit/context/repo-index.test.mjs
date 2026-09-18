// Unit: repo index (P5.1) — walk, symbols, edges, secret-path exclusion, symlink policy.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRepoIndex, extractFromText, isSecretPronePath } from "../../../packages/context/src/repo-index.ts";

function fixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), "aice-index-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "src", "util"));
  mkdirSync(join(root, "tests"));
  writeFileSync(join(root, "src", "app.ts"), [
    "import { helper } from \"./util/helper\";",
    "export function main(): number {",
    "  return helper();",
    "}",
    "export class App {}",
  ].join("\n"));
  writeFileSync(join(root, "src", "util", "helper.ts"), [
    "export function helper(): number { return 42; }",
    "const arrow = () => 1;",
    "export const seeded = arrow;",
  ].join("\n"));
  writeFileSync(join(root, "tests", "app.test.ts"), "// nothing exported\n");
  writeFileSync(join(root, "package.json"), "{ \"name\": \"idx-TESTONLY\" }\n");
  writeFileSync(join(root, ".env"), "API_KEY=ghp_TESTONLYabcdefghijklmnopqrstuv\n");
  writeFileSync(join(root, "src", "id_rsa"), "not-a-key-TESTONLY\n");
  mkdirSync(join(root, "secrets"));
  writeFileSync(join(root, "secrets", "token.txt"), "nope-TESTONLY\n");
  return root;
}

describe("repo index", () => {
  it("walks the tree, hashes files, and skips secret-prone content paths", () => {
    const root = fixtureRepo();
    try {
      const idx = buildRepoIndex(root);
      const paths = idx.files.map((f) => f.path);
      assert.ok(paths.includes("src/app.ts"));
      assert.ok(paths.includes("src/util/helper.ts"));
      assert.ok(paths.includes("package.json"));
      // hard exclusions: secret-prone files are NOT indexed at all
      assert.ok(!paths.includes(".env"));
      assert.ok(!paths.includes("src/id_rsa"));
      assert.ok(!paths.includes("secrets/token.txt"));
      const reasons = idx.skipped.map((s) => `${s.path}:${s.reason}`);
      assert.ok(reasons.some((r) => r.startsWith(".env:secret-prone")), reasons.join("|"));
      assert.ok(idx.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)), "every entry hashed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("extracts TS symbols with kinds and line numbers", () => {
    const root = fixtureRepo();
    try {
      const idx = buildRepoIndex(root);
      const appSyms = idx.symbols.filter((s) => s.file === "src/app.ts");
      const names = appSyms.map((s) => `${s.kind}:${s.name}:${s.line}`).sort();
      assert.ok(names.includes("function:main:2"), JSON.stringify(names));
      assert.ok(names.some((n) => n.startsWith("class:App:")), JSON.stringify(names));
      const helperSyms = idx.symbols.filter((s) => s.file === "src/util/helper.ts");
      assert.ok(helperSyms.some((s) => s.kind === "function" && s.name === "helper"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves internal import edges only (packages/builtins ignored)", () => {
    const root = fixtureRepo();
    try {
      const idx = buildRepoIndex(root);
      assert.ok(idx.edges.some((e) => e.from === "src/app.ts" && e.to === "src/util/helper.ts"), JSON.stringify(idx.edges));
      assert.ok(!idx.edges.some((e) => e.to === "node_modules" || e.to.includes("..")), "no out-of-root edges");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("symlinks are never followed (out-of-root escape proof)", () => {
    const root = fixtureRepo();
    try {
      const outside = mkdtempSync(join(tmpdir(), "aice-outside-"));
      writeFileSync(join(outside, "exposed.txt"), "outside-secret-TESTONLY\n");
      symlinkSync(outside, join(root, "link-out"));
      symlinkSync(join(root, "src", "app.ts"), join(root, "alias.ts"));
      const idx = buildRepoIndex(root);
      const paths = idx.files.map((f) => f.path);
      assert.ok(!paths.includes("alias.ts"), "file symlink skipped");
      assert.ok(!paths.includes("link-out/exposed.txt"), "dir symlink skipped");
      rmSync(outside, { recursive: true, force: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("extractFromText is pure-string and crashes on nothing adversarial", () => {
    const hostile = "😂😂\nimport{{{" + "x".repeat(5000) + "\ndef def def def)(";
    const { symbols, imports } = extractFromText("weird.py", hostile, "python");
    assert.ok(Array.isArray(symbols));
    assert.ok(Array.isArray(imports));
    // Python extraction sanity
    const { symbols: py } = extractFromText("m.py", "def foo(a, b):\n    pass\nclass Bar:\n    pass\nasync def baz():\n    pass\n", "python");
    assert.deepEqual(py.map((s) => s.name).sort(), ["Bar", "baz", "foo"]);
    assert.ok(isSecretPronePath("config/.env.local"));
    assert.ok(!isSecretPronePath("src/env/config.ts"));
  });
});
