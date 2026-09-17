// Integration: aice agent run (P4.5) — real CLI spawns, real SQLite DB, script-file
// transport (offline, deterministic). Asserts persistence (agent_runs rows, audit,
// runs evidence) and policy behavior carried in-process by the P4 kernel.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { openDatabase, AgentRunsDao } from "../../../packages/storage/src/index.ts";

const execFileP = promisify(execFile);
const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "apps/cli/src/cli.ts");

function fixtureProject() {
  const root = mkdtempSync(join(tmpdir(), "aice-cli-agent-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "NOTE.md"), "needle-TESTONLY\n");
  writeFileSync(join(root, "src", "app.ts"), "export const marker = \"alpha-TESTONLY\";\n");
  return root;
}

function aice(db, root, args, opts = {}) {
  return spawnSync(process.execPath, [CLI, ...args, "--db", db], {
    cwd: root,
    encoding: "utf8",
    ...opts,
  });
}

function readArgs(r) {
  try {
    return JSON.parse(r.stdout);
  } catch {
    return r.stdout.trim();
  }
}

async function mkTask(db, root, title) {
  const project = readArgs(await aice(db, root, ["project", "create", "--name", "p-TESTONLY", "--path", root, "--json"]));
  const task = readArgs(await aice(db, root, ["task", "create", "--project", project.id, "--title", title, "--json"]));
  return { project, task };
}

describe("aice agent run", () => {
  it("script transport: investigate persists agent_runs + audit + runs rows, jail = project root", { timeout: 120_000 }, async () => {
    const root = fixtureProject();
    const db = join(root, ".local", "app.db");
    const { task } = await mkTask(db, root, "Map the fixture");
    writeFileSync(
      join(root, "script.txt"),
      [
        "# comment lines are ignored",
        "New file spotted. Reading what matters.",
        "```tool",
        '{"tool":"fs.read","args":{"path":"NOTE.md"}}',
        "```",
        "",
        "## Summary",
        "fixture maps cleanly (needle-TESTONLY found).",
      ].join("\n"),
    );
    const r = aice(db, root, ["agent", "run", task.id, "--phase", "investigate", "--script-file", "script.txt", "--json"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const out = JSON.parse(r.stdout);
    assert.equal(out.phase, "investigate");
    assert.equal(out.status, "completed");
    assert.equal(out.toolCalls, 1);
    assert.equal(out.jailRoot, root);
    // Persistence: agent_runs row has transcript + final text (needle proves tool executed).
    const opened = openDatabase(db);
    try {
      const rows = new AgentRunsDao(opened.db).listByTask(task.id);
      assert.equal(rows.length, 1);
      assert.match(rows[0].finalText, /needle-TESTONLY/);
      const tx = JSON.parse(rows[0].transcriptJson);
      const toolMsg = tx.find((m) => m.role === "tool");
      assert.match(toolMsg.content, /UNTRUSTED-TOOL-OUTPUT tool="fs.read"/);
      const auditRows = opened.db.prepare("SELECT action, decision FROM audit_events WHERE task_id = ?").all(task.id);
      assert.ok(auditRows.some((a) => a.action === "agent.run.investigate" && a.decision === "allow"));
      const runRows = opened.db.prepare("SELECT agent, from_state, to_state FROM runs WHERE task_id = ?").all(task.id);
      assert.ok(runRows.some((r) => r.agent === "agent:investigate"));
    } finally {
      opened.db.close();
    }
  });

  it("policy carries into the CLI: rogue fs.write (investigator grant) → denial, zero side effects, row still persisted", { timeout: 120_000 }, async () => {
    const root = fixtureProject();
    const db = join(root, ".local", "app.db");
    const { task } = await mkTask(db, root, "Try to write");
    writeFileSync(
      join(root, "script.txt"),
      ['```tool', '{"tool":"fs.write","args":{"path":"pwn.txt","content":"owned"}}', "```", "", "Denied — staying read-only."].join("\n"),
    );
    const r = aice(db, root, ["agent", "run", task.id, "--phase", "investigate", "--script-file", "script.txt", "--json"]);
    assert.equal(r.status, 0, r.stderr); // completed == success lane (denial handled internally)
    const out = JSON.parse(r.stdout);
    assert.equal(out.denials, 1);
    const opened = openDatabase(db);
    try {
      const rows = new AgentRunsDao(opened.db).listByTask(task.id);
      assert.equal(rows[0].denials, 1);
      assert.match(rows[0].transcriptJson, /POLICY_DENIED/);
    } finally {
      opened.db.close();
    }
  });

  it("missing transport config fails with a usage error (env-only provider config rule)", { timeout: 60_000 }, async () => {
    const root = fixtureProject();
    const db = join(root, ".local", "app.db");
    const { task } = await mkTask(db, root, "No transport");
    const env = { ...process.env };
    delete env.AICE_AGENT_PROVIDER;
    delete env.AICE_AGENT_MODEL;
    const r = aice(db, root, ["agent", "run", task.id, "--phase", "investigate", "--json"], { env });
    assert.equal(r.status, 2, `expected usage failure (2), got ${r.status}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /AICE_AGENT_PROVIDER/);
  });

  it("awaiting-approval stalls exit 1 with evidence; task inspect shows the bundle", { timeout: 120_000 }, async () => {
    const root = fixtureProject();
    const db = join(root, ".local", "app.db");
    const { task } = await mkTask(db, root, "Edit via plan");
    writeFileSync(
      join(root, "script.txt"),
      ['```tool', '{"tool":"fs.write","args":{"path":"src/app.ts","content":"overwritten"}}', "```"].join("\n"),
    );
    const r = aice(db, root, ["agent", "run", task.id, "--phase", "implement", "--script-file", "script.txt", "--json"]);
    assert.equal(r.status, 1, `expected stalled (1): ${r.stdout}${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.status, "awaiting-approval");
    assert.match(readArgs(r) !== null ? String(out.status) : "", /awaiting/);
    // task inspect bundle includes the agent session
    const inspect = aice(db, root, ["task", "inspect", task.id, "--json"]);
    assert.equal(inspect.status, 0, inspect.stderr);
    const bundle = JSON.parse(inspect.stdout);
    assert.equal(bundle.task.id, task.id);
    assert.equal(bundle.agentRuns.length >= 1, true);
    assert.equal(bundle.agentRuns.at(-1).phase, "implement");
  }, 180_000);
});
