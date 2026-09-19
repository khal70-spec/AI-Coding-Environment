// Golden workflow (P9.7, Plan §53): the first-release operator journey as ONE
// scripted, end-to-end path — the same steps the user guide documents. Every stage
// is exercised through the real CLI/bridge lanes; the bridge read-side is cross-checked
// against the CLI write-side; the day ends with backup → migration truth → restore.
// Order mirrors the §53 acceptance workflow; evidence printed verbatim.
//
//   1. doctor            6. CLI approvals (plan → final at gates)
//   2. provider+model    7. governed state walk (advance → checkpoints hit/desired)
//   3. project create    8. findings + tests + verify evidence
//   4. task create       9. review + merge gates (APPROVED/MERGED, MERGED proven)
//   5. bridge read-side  10. audit tail + backup/restore across the same db
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = join(ROOT, "apps", "cli", "src", "cli.ts");
const NODE = process.execPath;

describe("§53 golden workflow: operator day one", { concurrency: false }, () => {
  let dir = "";
  let db = "";
  let projId = "";
  let taskId = "";
  let providerId = "";
  const aice = (args, ok = true) => {
    const r = aiceRaw(args);
    if (ok) assert.equal(r.status, 0, `${args.join(" ")}\n${r.stderr || r.stdout}`);
    return r;
  };
  const j = (r) => JSON.parse(r.stdout.trim());

  function aiceRaw(args) {
    try {
      const out = execFileSync(NODE, ["--no-warnings=Experimental", CLI, ...args, "--json", "--db", db], {
        encoding: "utf8", cwd: ROOT, stdio: ["pipe", "pipe", "pipe"],
      });
      return { status: 0, stdout: out, stderr: "" };
    } catch (e) {
      return { status: e.status ?? 1, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "") };
    }
  }
  function require([cmd, argv]) {
    const r = spawnSync(cmd, argv, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], shell: false });
    return { status: r.status ?? 1, stderr: String(r.stderr ?? "") };
  }

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "aice-sec53-"));
    db = join(dir, "app.db");
    // seed a "repo" that checkpoints wrap
    writeFileSync(join(dir, "README.md"), "# golden repo\n");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "main.ts"), "export const v = 1;\n");
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("1-4. doctor + provider + model + project + task", { timeout: 180_000 }, () => {
    const d = aice(["doctor"]);
    console.log(`#     doctor output rows: ${String(d.stdout).split("\n").length}`);
    const p = aice(["provider", "add", "--name", "replay-TESTONLY", "--protocol", "local-openai-compatible", "--base-url", "http://127.0.0.1:1", "--max-classification", "restricted"]);
    providerId = j(p).id;
    const pr = aice(["project", "create", "--name", "sec53", "--path", dir]);
    projId = j(pr).id;
    const t = aice(["task", "create", "--project", projId, "--title", "harden login path", "--risk", "high"]);
    taskId = j(t).id;
    console.log(`#     project=${projId.slice(0, 8)} task=${taskId.slice(0, 8)} provider=${providerId.slice(0, 8)}`);
  });

  it("5. bridge read-side reflects CLI writes (same accounting)", { timeout: 120_000 }, async () => {
    const { startBridge } = await import("../../apps/desktop/src/server.ts");
    const web = join(dir, "web");
    mkdirSync(web);
    writeFileSync(join(web, "index.html"), "<html></html>");
    const handle = await startBridge({ dbPath: db, actor: "op-TESTONLY", webRoot: web });
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/bridge`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: "tasks.show", args: { taskId } }),
      });
      const reply = await res.json();
      assert.equal(reply.ok, true);
      assert.equal(reply.data.task.id, taskId);
      assert.equal(reply.data.task.state, "CREATED");
      assert.equal(reply.data.project.id, projId);
    } finally {
      handle.close();
    }
  });

  it("6-9. governed walk to MERGED via every brake (approval/checkpoint/evidence/review)", { timeout: 300_000 }, () => {
    const show = (label) => {
      const row = j(aice(["task", "show", taskId]));
      console.log(`#     ${label.padEnd(22)} state=${row.task.state}`);
      return row.task.state;
    };
    // git repo fixture for checkpoint evidence
    for (const g of [["git", ["init", "-b", "main", dir]], ["git", ["-C", dir, "add", "-A"]], ["git", ["-C", dir, "-c", "user.email=aice@test.invalid", "-c", "user.name=aice-test", "commit", "-qm", "seed"]]]) {
      const r = require(g);
      if (r.status !== 0) throw new Error(`fixture git failed: ${g[1][g[1].length - 1]}`);
    }
    aice(["task", "advance", taskId]); // CLASSIFYING
    aice(["task", "advance", taskId]); // INVESTIGATING
    aice(["task", "advance", taskId]); // PLANNING
    aice(["task", "advance", taskId]); // WAITING_APPROVAL
    show("at approval brake");
    // brake #1: plan approval
    const b1 = aiceRaw(["task", "advance", taskId]);
    assert.notEqual(b1.status, 0, "PREPARING_WORKSPACE must refuse without plan approval");
    aice(["approve", "plan", taskId]);
    aice(["task", "advance", taskId]); // PREPARING_WORKSPACE
    // brake #2: checkpoint evidence
    const b2 = aiceRaw(["task", "advance", taskId]);
    assert.notEqual(b2.status, 0, "IMPLEMENTING must refuse without checkpoint");
    aice(["checkpoint", taskId]);
    aice(["task", "advance", taskId]); // IMPLEMENTING
    aice(["task", "advance", taskId]); // TESTING
    aice(["tests", "record", taskId, "--suite", "unit", "--passed", "12", "--failed", "0"]);
    aice(["task", "advance", taskId]); // SECURITY_REVIEW
    aice(["findings", "add", taskId, "--severity", "info", "--rule", "manual", "--summary", "clean sweep"]);
    aice(["task", "advance", taskId]); // AI_REVIEW
    aice(["review", taskId, "--by", "reviewer-bot-TESTONLY"]);
    aice(["task", "advance", taskId]); // VERIFYING
    aice(["verify", taskId, "--tests", "green", "--scans", "green"]);
    aice(["task", "advance", taskId]); // READY
    // brake #3: final approval on READY → APPROVED
    const b3 = aiceRaw(["task", "advance", taskId]);
    assert.notEqual(b3.status, 0, "APPROVED must refuse without final approval");
    aice(["approve", "final", taskId]);
    aice(["task", "advance", taskId]); // APPROVED
    aice(["task", "advance", taskId]); // MERGED
    assert.equal(show("final"), "MERGED");
  });

  it("10. audit is monotonic across the walk + backup/restore preserves the walk", { timeout: 180_000 }, () => {
    const au = aice(["audit", "--task", taskId]);
    const rows = j(au);
    const ids = rows.map((r) => r.id);
    assert.deepEqual([...ids].sort((a, b) => a - b), ids, "audit append-only monotonic");
    assert.ok(rows.some((r) => r.action === "approve.plan"));
    const backups = join(dir, "backups");
    mkdirSync(backups);
    const bu = runScript("db-backup.mjs", ["--out", backups]);
    assert.equal(bu.status, 0, bu.stdout + bu.stderr);
    assert.match(bu.stdout, /verified: integrity=ok/);
    const artifact = join(backups, readdirSync(backups).filter((f) => f.endsWith(".db")).sort().pop());
    const re = runScript("db-restore.mjs", [artifact]);
    assert.equal(re.status, 0, re.stdout + re.stderr);
    // post-restore reads must serve identical audit length
    const au2 = j(aice(["audit", "--task", taskId]));
    assert.equal(au2.length, rows.length);
  });

  function runScript(script, args) {
    try {
      const out = execFileSync(NODE, [join(ROOT, "scripts", script), ...args], {
        encoding: "utf8", cwd: ROOT, stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, DB_PATH: db },
      });
      return { status: 0, stdout: out, stderr: "" };
    } catch (e) {
      return { status: e.status, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "") };
    }
  }

});
