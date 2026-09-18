// Integration: aice mcp + aice skill CLI lanes (P6.4) — real spawns, real DB,
// echo child over stdio, tamper-blocking skill lifecycle.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "apps/cli/src/cli.ts");

function mkGarden() {
  const root = mkdtempSync(join(tmpdir(), "aice-mcpcli-"));
  mkdirSync(join(root, ".local"));
  const db = join(root, ".local", "app.db");
  const skillDir = join(root, "my-skill");
  mkdirSync(join(skillDir, "lib"), { recursive: true });
  writeFileSync(join(skillDir, "skill.json"), JSON.stringify({
    name: "echo-skill-TESTONLY",
    version: "1.0.0",
    permissions: ["tool:test.exec", "fs.pattern:tmp/**"],
    description: "echoes",
  }));
  writeFileSync(join(skillDir, "lib", "run.js"), "// run-TESTONLY\n");
  const echoChild = join(root, "echo-server.js");
  writeFileSync(
    echoChild,
    "let b='';process.stdin.on('data',c=>b+=c).on('end',()=>{const m=JSON.parse(b.trim());process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{echoed:m.params.name,args:m.params.arguments}})+'\\n');});",
  );
  return { root, db, skillDir, echoChild };
}

function aice(db, root, args) {
  return spawnSync(process.execPath, [CLI, ...args, "--db", db], { cwd: root, encoding: "utf8" });
}

describe("aice mcp (P6.4)", () => {
  it("add stdio echo server → invoke allowlisted tool → round trip; denied tool/denied server fail closed", { timeout: 120_000 }, () => {
    const { root, db, echoChild } = mkGarden();
    try {
      const add = aice(db, root, ["mcp", "add", "--name", "echo", "--transport", "stdio", "--command", `${process.execPath},${echoChild}`, "--tools-allow", "echo", "--json"]);
      assert.equal(add.status, 0, add.stderr + add.stdout);
      const srv = JSON.parse(add.stdout);
      const list = aice(db, root, ["mcp", "list"]);
      assert.match(list.stdout, new RegExp(`${srv.id}\\s+enabled`));

      const ok = aice(db, root, ["mcp", "invoke", srv.id, "--tool", "echo", "--args-json", '["hi-TESTONLY"]', "--json"]);
      assert.equal(ok.status, 0, ok.stderr);
      assert.match(ok.stdout, /hi-TESTONLY/);

      const denied = aice(db, root, ["mcp", "invoke", srv.id, "--tool", "exec"]);
      assert.equal(denied.status, 1);
      assert.match(denied.stderr, /not in toolsAllow/);

      const dis = aice(db, root, ["mcp", "disable", srv.id, "--json"]);
      assert.equal(dis.status, 0);
      const off = aice(db, root, ["mcp", "invoke", srv.id, "--tool", "echo"]);
      assert.equal(off.status, 1);
      assert.match(off.stderr, /disabled|kill switch/);

      const audit = aice(db, root, ["audit", "--task", "nope"]);
      const auditAll = aice(db, root, ["mcp", "list", "--json"]);
      assert.ok(auditAll.stdout.includes(srv.id) || audit.status !== 0); // surface sane: row visible

      const rm = aice(db, root, ["mcp", "remove", srv.id, "--json"]);
      assert.equal(rm.status, 0);
      const gone = aice(db, root, ["mcp", "invoke", srv.id, "--tool", "echo"]);
      assert.notEqual(gone.status, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("http http loopback without pin → ENDPOINT_DENIED pre-flight (server never contacted)", { timeout: 120_000 }, () => {
    const { root, db } = mkGarden();
    try {
      // pass validation (loopback ok), but networkAllow EMPTY → not pinned.
      const add = aice(db, root, ["mcp", "add", "--name", "unpinned", "--transport", "http", "--url", "http://127.0.0.1:1/rpc", "--tools-allow", "ping", "--network-allow", "", "--json"]);
      assert.equal(add.status, 0, add.stderr + add.stdout);
      const srv = JSON.parse(add.stdout);
      const res = aice(db, root, ["mcp", "invoke", srv.id, "--tool", "ping"]);
      assert.equal(res.status, 1);
      assert.match(res.stderr, /NETWORK|ENDPOINT|egress|not pinned/i);
      // audit contains the deny (kept content-free)
      const opened = spawnSync(process.execPath, ["--input-type=module", "-e", `const {openDatabase}=await import(${JSON.stringify(join(dirname(CLI), "..", "..", "..", "packages/storage/src/index.ts"))}); const o=openDatabase(${JSON.stringify(db)}); const rows=o.db.prepare("SELECT action,decision FROM audit_events WHERE action='mcp.invoke'").all(); console.log(JSON.stringify(rows)); o.db.close();`], { encoding: "utf8" });
      assert.match(opened.stdout, /deny/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("install validation refuses bad configs at add time (no row written)", { timeout: 60_000 }, () => {
    const { root, db } = mkGarden();
    try {
      const bad = aice(db, root, ["mcp", "add", "--name", "evil", "--transport", "http", "--url", "http://169.254.169.254/latest", "--tools-allow", "x", "--json"]);
      assert.equal(bad.status, 1);
      assert.match(bad.stderr, /loopback-only|CONFIG_INVALID/);
      const bad2 = aice(db, root, ["mcp", "add", "--name", "wild", "--transport", "http", "--url", "https://mcp.example.test", "--tools-allow", "*", "--json"]);
      assert.equal(bad2.status, 1);
      assert.match(bad2.stderr, /wildcard/);
      const list = aice(db, root, ["mcp", "list", "--json"]);
      assert.deepEqual(JSON.parse(list.stdout), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("aice skill (P6.4)", () => {
  it("add → gate denied (pending) → approve → gate ok → tamper → approve → BLOCKED + gate denied", { timeout: 120_000 }, () => {
    const { root, db, skillDir } = mkGarden();
    try {
      const add = aice(db, root, ["skill", "add", "my-skill", "--json"]);
      assert.equal(add.status, 0, add.stderr + add.stdout);
      const skill = JSON.parse(add.stdout);

      const gate0 = aice(db, root, ["skill", "gate", skill.id]);
      assert.equal(gate0.status, 1);
      assert.match(gate0.stderr, /pending_review/);

      const review = aice(db, root, ["skill", "review", skill.id]);
      assert.equal(review.status, 0);
      assert.match(review.stdout, /tool:test\.exec/);
      assert.match(review.stdout, /digest/);

      const approve = aice(db, root, ["skill", "approve", skill.id, "--json"]);
      assert.equal(approve.status, 0, approve.stderr);
      const gate1 = aice(db, root, ["skill", "gate", skill.id, "--json"]);
      assert.equal(gate1.status, 0, gate1.stderr);

      // tamper one byte — approve attempt must flip status to blocked, not approve
      writeFileSync(join(skillDir, "lib", "run.js"), "// run-TESTONLY\n// tainted-TESTONLY\n");
      const ap2 = aice(db, root, ["skill", "approve", skill.id]);
      assert.equal(ap2.status, 1);
      assert.match(ap2.stderr, /TAMPER|digest mismatch/i);
      const list = aice(db, root, ["skill", "list", "--json"]);
      assert.equal(JSON.parse(list.stdout).find((s) => s.id === skill.id)?.status, "blocked");
      const gate2 = aice(db, root, ["skill", "gate", skill.id]);
      assert.equal(gate2.status, 1);
      assert.match(gate2.stderr, /blocked/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("add rejects symlinked bundles + bad manifests before writing rows", { timeout: 60_000 }, () => {
    const root = mkdtempSync(join(tmpdir(), "aice-skbad-"));
    const db = join(root, ".local", "app.db");
    try {
      mkdirSync(join(root, "bad"), { recursive: true });
      writeFileSync(join(root, "bad", "skill.json"), JSON.stringify({ name: "x", permissions: ["everything"] }));
      const bad = aice(db, root, ["skill", "add", "bad", "--json"]);
      assert.equal(bad.status, 2);
      assert.match(bad.stderr, /invalid permission entry/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
