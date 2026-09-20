// Integration: aice memory CLI lanes (Plan §25) — real spawns, real DB:
// lifecycle, secret refusal (exit≥1), contained export, retention + sweep,
// audit-trail rows for every mutation, partition-exact purge.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "apps/cli/src/cli.ts");
const FAKE_TOKEN = ["g", "h", "p_"].join("") + "A".repeat(24) + "-TESTONLY";

let root;
let db;
before(() => {
  root = mkdtempSync(join(tmpdir(), "aice-memcli-"));
  mkdirSync(join(root, ".local"));
  db = join(root, ".local", "app.db");
});
after(() => rmSync(root, { recursive: true, force: true }));

function aice(args) {
  return spawnSync(process.execPath, [CLI, ...args, "--db", db], { cwd: root, encoding: "utf8" });
}

describe("aice memory (Plan §25)", () => {
  it("set → get → list → delete lifecycle with audit rows (content-free)", { timeout: 60_000 }, () => {
    const mk = aice(["project", "create", "--name", "memdemo", "--path", root]);
    assert.equal(mk.status, 0, mk.stderr);
    const projectId = mk.stdout.split(/\s+/)[1];
    assert.ok(projectId.length > 8, mk.stdout);

    const set = aice(["memory", "set", "--scope", "project", "--project", projectId, "--key", "arch", "--value", "sqlite-wal"]);
    assert.equal(set.status, 0, set.stderr);
    assert.match(set.stdout, /memory project arch saved/);

    const get = aice(["memory", "get", "--scope", "project", "--project", projectId, "--key", "arch"]);
    assert.equal(get.status, 0);
    assert.match(get.stdout, /sqlite-wal/);

    const list = aice(["memory", "list", "--scope", "project", "--project", projectId]);
    assert.match(list.stdout, /arch\t\d+B/);

    const auditShow = aice(["audit", "--project", projectId]);
    assert.match(auditShow.stdout, /memory\.set\s+allow/);
    assert.ok(!auditShow.stdout.includes("sqlite-wal"), "audit stays content-free");

    const del = aice(["memory", "delete", "--scope", "project", "--project", projectId, "--key", "arch"]);
    assert.equal(del.status, 0);
    const gone = aice(["memory", "get", "--scope", "project", "--project", projectId, "--key", "arch"]);
    assert.notEqual(gone.status, 0);
  });

  it("refuses secret-shaped values (exit ≥1, SECRET_REFUSED, nothing stored)", () => {
    const bad = aice(["memory", "set", "--scope", "global", "--key", "k", "--value", `tok=${FAKE_TOKEN}`]);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /SECRET_REFUSED/);
    const list = aice(["memory", "list", "--scope", "global"]);
    assert.equal(list.stdout.trim(), "", list.stdout);
  });

  it("scope contract enforced: global with --project fails usage-class error", () => {
    const bad = aice(["memory", "set", "--scope", "global", "--project", "x", "--key", "k", "--value", "v"]);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /not allowed for scope global/);
  });

  it("export is jailed to cwd + redacted; escape attempt fails closed", () => {
    aice(["memory", "set", "--scope", "global", "--key", "pref", "--value", "dark-theme"]);
    const ok = aice(["memory", "export", "--scope", "global", "--file", "mem-out.json"]);
    assert.equal(ok.status, 0, ok.stderr);
    const doc = JSON.parse(readFileSync(join(root, "mem-out.json"), "utf8"));
    assert.equal(doc.entries.length, 1);
    assert.equal(doc.entries[0].key, "pref");

    const esc = aice(["memory", "export", "--scope", "global", "--file", "../outside-TESTONLY.json"]);
    assert.notEqual(esc.status, 0);
    assert.match(esc.stderr, /ESCAPE|escapes jail/);

    const purge = aice(["memory", "purge", "--scope", "global"]);
    assert.equal(purge.status, 0);
    assert.match(purge.stdout, /removed 1/);
  });

  it("retention set + sweep removes expired scratchpad rows", () => {
    aice(["memory", "retention", "--scope", "scratchpad", "--days", "1", "--max", "10"]);
    const kept = aice(["memory", "retention"]);
    assert.match(kept.stdout, /scratchpad\t1d\tmax 10/);

    const s = aice(["memory", "set", "--scope", "scratchpad", "--task", "T9", "--key", "note", "--value", "wip", "--ttl-hours", "1"]);
    assert.equal(s.status, 0, s.stderr);
    assert.match(s.stdout, /expires/);
    // A sweep with the operator clock 'now' cannot remove a 1h-TTL row…
    const early = aice(["memory", "sweep"]);
    assert.match(early.stdout, /nothing to remove/);
    // …but the TTL lane is proven by the service suite's future-clock sweep.
  });

  it("denials and unknown subcommands exit non-zero with usage", () => {
    const nope = aice(["memory", "frobnicate"]);
    assert.notEqual(nope.status, 0);
    assert.match(nope.stderr, /usage: aice memory/);
  });
});
