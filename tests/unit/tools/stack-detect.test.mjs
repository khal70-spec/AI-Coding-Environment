// Unit: stack detection fixtures (P3.3). Pure filesystem sniffing, in-jail.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectStack } from "../../../packages/tools/src/stack-detect.ts";

const dir = () => mkdtempSync(join(tmpdir(), "aice-stack-"));

describe("detectStack", () => {
  const cases = [
    { files: { "package.json": '{"name":"x"}' }, kind: "node", marker: "package.json", argvStart: ["npm", "test"] },
    { files: { "requirements.txt": "pytest\n" }, kind: "python", marker: "requirements.txt", argvStart: ["python3", "-m", "pytest"] },
    { files: { "pyproject.toml": "[project]\n" }, kind: "python", marker: "pyproject.toml", argvStart: ["python3", "-m", "pytest"] },
    { files: { "WidgetApp.csproj": "<Project />\n" }, kind: "dotnet", marker: "WidgetApp.csproj", argvStart: ["dotnet", "test"] },
    { files: { "Cargo.toml": "[package]\n" }, kind: "rust", marker: "Cargo.toml", argvStart: ["cargo", "test"] },
    { files: { "go.mod": "module x\n" }, kind: "go", marker: "go.mod", argvStart: ["go", "test", "./..."] },
    { files: { "composer.json": "{}\n" }, kind: "php", marker: "composer.json", argvStart: ["composer", "test"] },
  ];

  for (const c of cases) {
    it(`detects ${c.kind} via ${c.marker}`, () => {
      const d = dir();
      for (const [f, content] of Object.entries(c.files)) writeFileSync(join(d, f), content);
      const info = detectStack(d);
      assert.equal(info.kind, c.kind);
      assert.equal(info.marker, c.marker);
      assert.deepEqual([...(info.testArgv ?? [])].slice(0, c.argvStart.length), c.argvStart);
    });
  }

  it("node wins when multiple markers exist (order is deterministic)", () => {
    const d = dir();
    writeFileSync(join(d, "package.json"), "{}");
    writeFileSync(join(d, "requirements.txt"), "");
    assert.equal(detectStack(d).kind, "node");
  });

  it("unknown for empty/unrelated dirs", () => {
    const d = dir();
    writeFileSync(join(d, "notes.txt"), "hello\n");
    const info = detectStack(d);
    assert.equal(info.kind, "unknown");
    assert.equal(info.testArgv, null);
  });

  it("unparsable package.json still detects node (npm test is the allowslisted argv)", () => {
    const d = dir();
    writeFileSync(join(d, "package.json"), "{not json");
    const info = detectStack(d);
    assert.equal(info.kind, "node");
    assert.deepEqual([...(info.testArgv ?? [])], ["npm", "test"]);
  });
});
