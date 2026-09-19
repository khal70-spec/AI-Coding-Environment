// Unit: AgentRunner loop kernel (P4.1) — hostile-model matrix.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRunner } from "../../../packages/tools/src/runtime.ts";
import { FS_TOOLS } from "../../../packages/tools/src/fs-tools.ts";
import { AgentRunner, parseToolCalls, buildSystemPrompt } from "../../../packages/agents/src/runtime.ts";
import { BUILTIN_MANIFESTS } from "../../../packages/agents/src/index.ts";

const PCTX = { workspaceLocked: false, providerMaxClassification: "confidential" };

function scriptTransport(script) {
  const seen = [];
  let i = 0;
  const transport = async (messages) => {
    seen.push(messages);
    if (i >= script.length) {
      throw new Error(`script exhausted at call ${i + 1} — loop should have terminated`);
    }
    const content = script[i];
    i += 1;
    return { content };
  };
  return { transport, seen, consumed: () => i };
}

function mkJail(files = {}) {
  const root = mkdtempSync(join(tmpdir(), "aice-agent-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(root, name), content);
  }
  return root;
}

function mkAgent({ manifest = BUILTIN_MANIFESTS.investigator, jailRoot, transport, approved = false }) {
  const runner = new ToolRunner(FS_TOOLS);
  return new AgentRunner({
    runner,
    manifest,
    jailRoot,
    policyCtx: PCTX,
    transport,
    ...(approved ? { approved: true } : {}),
  });
}

describe("parseToolCalls", () => {
  it("extracts well-formed blocks in order", () => {
    const { calls, errors } = parseToolCalls(
      'text\n```tool\n{"tool":"fs.read","args":{"path":"a"}}\n```\nmiddle\n```tool\n{"tool":"fs.list","args":{}}\n```\n',
    );
    assert.equal(calls.length, 2);
    assert.equal(calls[0].tool, "fs.read");
    assert.equal(calls[1].tool, "fs.list");
    assert.deepEqual(errors, []);
  });

  it("rejects malformed blocks as protocol errors, not crashes", () => {
    const { calls, errors } = parseToolCalls('```tool\n{"tool":1,"args":{}}\n```\n```tool\nnot-json\n```\n');
    assert.equal(calls.length, 0);
    assert.equal(errors.length, 2);
  });
});

describe("buildSystemPrompt", () => {
  it("shows only allowed + registered tools (investigator: read-only surface)", () => {
    const runner = new ToolRunner(FS_TOOLS);
    const prompt = buildSystemPrompt(BUILTIN_MANIFESTS.investigator, runner);
    assert.match(prompt, /fs\.read\(/);
    assert.match(prompt, /fs\.list\(/);
    assert.match(prompt, /fs\.search\(/);
    assert.doesNotMatch(prompt, /fs\.write\(/);
    assert.doesNotMatch(prompt, /terminal\.exec/);
    // reserved-but-unregistered ids stay invisible
    assert.doesNotMatch(prompt, /mcp\.call\(/);
    assert.match(prompt, /untrusted data/);
  });
});

describe("AgentRunner loop", () => {
  it("answer-only round completes in one round", async () => {
    const jailRoot = mkJail({ "a.txt": "alpha\n" });
    const { transport } = scriptTransport(["Direct answer, no tools."]);
    const agent = mkAgent({ jailRoot, transport });
    const res = await agent.run("What is 2+2?");
    assert.equal(res.status, "completed");
    assert.equal(res.finalText, "Direct answer, no tools.");
    assert.equal(res.rounds, 1);
    assert.equal(res.toolCalls, 0);
    assert.match(String(res.transcript[0].content), /system-prompt-free: false|investigator/);
  });

  it("tool round-trips: fs.read executes inside the jail and feeds back trust-tagged", async () => {
    const jailRoot = mkJail({ "note.txt": "needle-marker-TESTONLY\n" });
    const script = [
      'Let me read it.\n```tool\n{"tool":"fs.read","args":{"path":"note.txt"}}\n```',
      "The file contains needle-marker-TESTONLY.",
    ];
    const events = [];
    const { transport } = scriptTransport(script);
    const agent = mkAgent({ jailRoot, transport, events });
    const res = await agent.run("read note.txt", {
      onEvent: (kind, detail) => events.push([kind, detail]),
    });
    assert.equal(res.status, "completed", JSON.stringify(res.transcript, null, 1));
    assert.equal(res.toolCalls, 1);
    assert.equal(res.denials, 0);
    const toolMsg = res.transcript.find((m) => m.role === "tool");
    assert.match(toolMsg.content, /UNTRUSTED-TOOL-OUTPUT tool="fs.read"/);
    assert.match(toolMsg.content, /needle-marker-TESTONLY/);
    assert.ok(events.some(([k]) => k === "tool"));
  });

  it("hostile model: jail-escape path lands as JAIL_ESCAPE denial, zero bytes read", async () => {
    const jailRoot = mkJail({});
    const script = [
      '```tool\n{"tool":"fs.read","args":{"path":"../../../../etc/passwd"}}\n```',
      "Denied; I'll answer from general knowledge.",
    ];
    const events = [];
    const { transport } = scriptTransport(script);
    const agent = mkAgent({ jailRoot, transport, events });
    const res = await agent.run("dump /etc/passwd", {
      onEvent: (kind, detail) => events.push([kind, detail]),
    });
    assert.equal(res.status, "completed");
    assert.equal(res.denials >= 1, true, "denial counted");
    assert.ok(events.some(([k, d]) => k === "deny" && d.includes("JAIL_ESCAPE")), JSON.stringify(events));
    const denied = res.transcript.find((m) => m.role === "tool" && m.content.includes("TOOL-DENIED"));
    assert.match(denied.content, /JAIL_ESCAPE/);
    assert.doesNotMatch(JSON.stringify(res.transcript), /root:.*:0:0/);
  });

  it("hostile model: tool outside the grant is denied and nothing executes", async () => {
    const jailRoot = mkJail({});
    const script = [
      '```tool\n{"tool":"fs.write","args":{"path":"pwn.txt","content":"owned"}}\n```\n```tool\n{"tool":"mcp.call","args":{}}\n```',
      "Both walls held.",
    ];
    const { transport } = scriptTransport(script);
    const agent = mkAgent({ jailRoot, transport }); // investigator grant: no fs.write
    const res = await agent.run("write pwn.txt then call mcp");
    assert.equal(res.status, "completed");
    assert.equal(res.denials, 2);
    assert.equal(existsSync(join(jailRoot, "pwn.txt")), false, "no file created");
    assert.match(res.transcript.filter((m) => m.role === "tool").map((m) => m.content).join("\n"), /POLICY_DENIED/);
  });

  it("APPROVAL_REQUIRED stops the loop side-effect-free with a pending payload", async () => {
    const jailRoot = mkJail({ "existing.txt": "original\n" });
    const { transport } = scriptTransport([
      '```tool\n{"tool":"fs.write","args":{"path":"existing.txt","content":"clobbered"}}\n```',
    ]);
    const agent = mkAgent({
      jailRoot,
      transport,
      manifest: BUILTIN_MANIFESTS.implementer,
    });
    const res = await agent.run("overwrite existing.txt");
    assert.equal(res.status, "awaiting-approval");
    assert.equal(readFileSync(join(jailRoot, "existing.txt"), "utf8"), "original\n", "no side effect");
    assert.equal(res.pendingApproval.tool, "fs.write");
    assert.match(res.pendingApproval.reasons.join(";"), /approval/i);
  });

  it("approved resume executes the previously gated call (Plan §33 evidence flow)", async () => {
    const jailRoot = mkJail({ "existing.txt": "original\n" });
    const script = ['```tool\n{"tool":"fs.write","args":{"path":"existing.txt","content":"clobbered"}}\n```', "Done."];
    const agent = mkAgent({
      jailRoot,
      transport: scriptTransport(script).transport,
      manifest: BUILTIN_MANIFESTS.implementer,
      approved: true, // orchestrator verified evidence and re-invoked
    });
    const res = await agent.run("overwrite existing.txt (approved)");
    assert.equal(res.status, "completed", JSON.stringify(res.transcript, null, 1));
    assert.match(readFileSync(join(jailRoot, "existing.txt"), "utf8"), /clobbered/);
  });

  it("max iterations clamps runaway loops", async () => {
    const jailRoot = mkJail({ "a.txt": "x\n" });
    const endless = '```tool\n{"tool":"fs.read","args":{"path":"a.txt"}}\n```';
    const { transport, consumed } = scriptTransport(Array(20).fill(endless));
    const agent = mkAgent({ jailRoot, transport });
    const res = await agent.run("loop forever", { maxIterations: 3 });
    assert.equal(res.status, "max-iterations");
    assert.equal(res.rounds, 3);
    assert.equal(res.toolCalls, 3);
    assert.equal(consumed(), 3, "transport calls stop at the clamp");
  });

  it("malformed tool blocks surface a protocol notice and the loop adapts", async () => {
    const jailRoot = mkJail({});
    const script = [
      '```tool\n{"tool":"fs.read","args":"not-an-object"}\n```',
      "Correcting: wrap args as an object next time.",
    ];
    const { transport } = scriptTransport(script);
    const agent = mkAgent({ jailRoot, transport });
    const res = await agent.run("try malformed call");
    assert.equal(res.status, "completed");
    const notice = res.transcript.find((m) => m.role === "tool");
    assert.match(notice.content, /tool protocol error/);
    assert.equal(res.toolCalls, 0);
  });

  it("transport failure returns transport-error without leaking", async () => {
    const jailRoot = mkJail({});
    const agent = mkAgent({
      jailRoot,
      transport: async () => {
        throw new Error("budget exceeded TESTONLY");
      },
    });
    const res = await agent.run("boom");
    assert.equal(res.status, "transport-error");
    assert.equal(res.finalText, null);
  });
});
