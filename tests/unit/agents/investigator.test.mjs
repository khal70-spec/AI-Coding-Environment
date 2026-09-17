// Unit: investigator flow over the AgentRunner kernel (P4.2).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRunner } from "../../../packages/tools/src/runtime.ts";
import { FS_TOOLS } from "../../../packages/tools/src/fs-tools.ts";
import { investigate } from "../../../packages/agents/src/investigator.ts";

const PCTX = { workspaceLocked: false, providerMaxClassification: "confidential" };

function fixtureWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "aice-inv-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture-TESTONLY", version: "0.0.0" }));
  writeFileSync(join(root, "src", "server.ts"), "export function listen() { return 4040; }\n");
  writeFileSync(join(root, "src", "route.ts"), "// alpha-marker-TESTONLY\nexport const route = \"/api/health\";\n");
  writeFileSync(join(root, "docs", "arch.md"), "# arch\nsmall fixture\n");
  return root;
}

function scripted(steps) {
  let i = 0;
  return async () => {
    assert.ok(i < steps.length, `script exhausted at step ${i + 1}`);
    const content = steps[i];
    i += 1;
    return { content };
  };
}

describe("investigator", () => {
  it("explores a fixture workspace read-only and returns a structured note", async () => {
    const root = fixtureWorkspace();
    const transport = scripted([
      'Start at the top.\n```tool\n{"tool":"fs.list","args":{"path":".","depth":2}}\n```',
      '```tool\n{"tool":"fs.search","args":{"pattern":"alpha-marker"}}\n```',
      '```tool\n{"tool":"fs.read","args":{"path":"src/route.ts"}}\n```',
      [
        "## Summary",
        "Fixture has a server + one route.",
        "## Relevant code (file:line)",
        "src/route.ts:2 — route constant",
        "## Dependencies & entry points",
        "node project; src/server.ts listen()",
        "## Risks / security notes",
        "none material (TESTONLY fixture)",
        "## Suggested verification (tests/scans)",
        "run test.exec (node) after any edit",
      ].join("\n"),
    ]);
    const res = await investigate(
      { runner: new ToolRunner(FS_TOOLS), jailRoot: root, policyCtx: PCTX, transport, task: { title: "Map the fixture", hints: ["alpha-marker"] } },
      { maxIterations: 6 },
    );
    assert.equal(res.status, "completed");
    assert.equal(res.toolCalls, 3);
    assert.match(res.note, /## Summary/);
    assert.match(res.note, /src\/route\.ts:2/);
    // transcript proves the read-only posture: list→search→read only
    const toolUses = res.transcript.filter((m) => m.role === "tool").map((m) => m.content);
    assert.ok(toolUses.some((c) => c.includes('tool="fs.list"')));
    assert.ok(toolUses.some((c) => c.includes('tool="fs.search"')));
    assert.ok(toolUses.some((c) => c.includes('tool="fs.read"')));
    assert.ok(!toolUses.some((c) => c.includes("TOOL-DENIED")));
  });

  it("manifest holds the line: fs.write attempt (if model tries) is denied and logged", async () => {
    const root = fixtureWorkspace();
    const transport = scripted([
      'Rogue idea: write a scratch note.\n```tool\n{"tool":"fs.write","args":{"path":"scratch.txt","content":"x"}}\n```',
      "Denied, staying read-only.",
      "Done — note follows.",
    ]);
    const res = await investigate(
      { runner: new ToolRunner(FS_TOOLS), jailRoot: root, policyCtx: PCTX, transport, task: { title: "Probe walls" } },
    );
    assert.equal(res.status, "completed");
    assert.equal(res.denials, 1);
    assert.match(res.transcript.map((m) => m.content).join("\n"), /TOOL-DENIED tool="fs.write" code="POLICY_DENIED"/);
  });
});
