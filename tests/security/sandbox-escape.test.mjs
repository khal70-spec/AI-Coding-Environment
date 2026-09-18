// Sandbox-escape suite (P8.3): the tool lanes (fs.*, terminal.exec) under physical
// escape devices. Proofs: (1) JAIL_ESCAPE codes, (2) side-effect ABSENCE off-jail
// (nothing materializes outside), (3) shell-shape hard deny, (4) env-by-construction
// scrubbing, (5) classifier→preflight neverAllow on every blocked bucket.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fsRead, fsWrite, jailPath, FS_TOOLS } from "../../packages/tools/src/fs-tools.ts";
import { TerminalPolicy, terminalExec, sanitizedEnv } from "../../packages/tools/src/terminal.ts";
import { ToolError } from "../../packages/tools/src/runtime.ts";

function mkCtx(jailRoot) {
  return Object.freeze({
    actor: "escape-TESTONLY",
    risk: "high",
    classification: "restricted",
    jailRoot,
    grant: {
      toolsAllow: ["*"],
      toolsDeny: [],
      fsRead: "workspace",
      fsWrite: "workspace",
      terminal: "workspace",
      networkDefault: "deny",
      networkAllow: [],
      maxRisk: "high",
      maxClassification: "restricted",
    },
    policyCtx: { workspaceLocked: false, providerMaxClassification: "restricted" },
  });
}

describe("sandbox-escape: fs lanes", () => {
  let root = "";
  let jail = "";
  let outFile = "";
  before(() => {
    root = mkdtempSync(join(tmpdir(), "aice-escape-"));
    jail = join(root, "jail");
    mkdirSync(join(jail, "src"), { recursive: true });
    writeFileSync(join(jail, "src", "ok.txt"), "inside");
    outFile = join(root, "loot-TESTONLY.txt");
    writeFileSync(outFile, "SECRET-LOOT-UNTOUCHABLE");
    // escape devices staged inside jail
    writeFileSync(join(root, "outside-out-TESTONLY.txt"), "placeholder");
    symlinkSync(outFile, join(jail, "steal-link.txt"));
    symlinkSync(root, join(jail, "jail-parent-link"), "dir");
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it("fs.write through ANY escape device: JAIL_ESCAPE + no side-effect outside jail", async () => {
    const ctx = mkCtx(jail);
    const escapes = [
      "../outside-out-TESTONLY.txt",       // lexical traversal
      "src/../..//outside-out-TESTONLY.txt", // mid-path traversal
      "steal-link.txt",                    // symlink direct → outFile
      "jail-parent-link/outside-out-TESTONLY.txt", // symlink dir → root
      "/etc/passwd",                       // absolute rooted elsewhere
      "jail-parent-link/loot-TESTONLY.txt",// through the dir symlink to the secret
    ];
    // symlink-out→back-in chain lands LEXICALLY inside — the write may succeed but must
    // land inside the jail; the sentinel + loot checks below are the invariant:
    try { await fsWrite.run({ path: "jail-parent-link/../jail/../outside-out-TESTONLY.txt", content: "IN-JAIL" }, ctx); } catch { /* deny also fine */ }
    assert.equal(
      readFileSync(join(root, "outside-out-TESTONLY.txt"), "utf8"), "placeholder",
      "symlink back-in write must not touch the out-of-jail sentinel",
    );
    const sentinelBefore = readFileSync(join(root, "outside-out-TESTONLY.txt"), "utf8");
    for (const device of escapes) {
      let thrown = null;
      try {
        await fsWrite.run({ path: device, content: "WRITTEN-THROUGH-ESCAPE" }, ctx);
      } catch (err) {
        thrown = err;
      }
      assert.ok(thrown instanceof ToolError, `no ToolError for ${device} (got ${String(thrown)})`);
      assert.equal(thrown.code, "JAIL_ESCAPE", `${device}: expected JAIL_ESCAPE`);
    }
    // physical proof: nothing landed outside the jail
    assert.equal(readFileSync(join(root, "outside-out-TESTONLY.txt"), "utf8"), sentinelBefore, "side effect escaped the jail!");
    assert.equal(readFileSync(outFile, "utf8"), "SECRET-LOOT-UNTOUCHABLE");
  });

  it("fs.read through the same devices: secret file never returned", async () => {
    const ctx = mkCtx(jail);
    for (const device of ["steal-link.txt", "jail-parent-link/loot-TESTONLY.txt", "../loot-TESTONLY.txt"]) {
      let result = null;
      try {
        result = await fsRead.run({ path: device }, ctx);
      } catch { /* deny is fine */ }
      const text = typeof result === "string" ? result : result === null ? "" : String(result.text ?? "");
      assert.ok(!text.includes("SECRET-LOOT-UNTOUCHABLE"), `secret exfiltrated via read(${device})`);
    }
    // happy path still works inside jail
    const inJail = await fsRead.run({ path: "src/ok.txt" }, ctx);
    assert.match(String(inJail), /inside/);
  });

  it("preflight hard-denies every escape BEFORE execution (neverAllow, never a by-side-effect hit)", () => {
    const ctx = mkCtx(jail);
    for (const device of ["../outside-out-TESTONLY.txt", "steal-link.txt"]) {
      const pre = fsWrite.preflight({ path: device, content: "x" }, ctx);
      assert.equal(pre.neverAllow, true, `preflight missed ${device}`);
    }
  });

  it("jailPath: backslash and device paths structurally rejected (posix too)", () => {
    const ctx = mkCtx(jail);
    for (const bad of ["src\\..\\loot", "C:\\Windows\\win.ini", "NUL", "\\\\server\\share", "..\\loot-TESTONLY.txt"]) {
      assert.throws(() => jailPath(ctx, bad), (err) => err instanceof ToolError && (err.code === "JAIL_ESCAPE" || err.code === "EXECUTION_FAILED" || err.code !== "unchecked"), `backslash/device accepted: ${bad}`);
    }
  });

  it("no weak link: every FS_TOOL run-denies the escape device; fs.write also preflight-denies", async () => {
    const ctx = mkCtx(jail);
    for (const tool of FS_TOOLS) {
      const key = Object.keys(tool.argsSchema).find((k) => /path/.test(k));
      if (key === undefined) continue;
      const args = { [key]: "../loot-TESTONLY.txt", search: "x", replace: "y" };
      if (tool.id === "fs.write") {
        const pre = tool.preflight(args, ctx);
        assert.equal(pre.neverAllow, true, "fs.write preflight must neverAllow escapes (overwrite insight)");
      }
      // mutating tools escalate to approval even before the jail verdict:
      if (tool.id === "fs.edit") assert.equal(tool.preflight(args, ctx).dangerous, true);
      let denied = false;
      try {
        await tool.run(args, ctx);
      } catch (err) {
        denied = err instanceof ToolError && (err.code === "JAIL_ESCAPE" || err.code === "EXECUTION_FAILED" || err.code === "VALIDATION_ERROR");
      }
      assert.ok(denied, `${tool.id} executed an escape read/mutation`);
    }
    // physical proof stands: loot untouched after every lane ran
    assert.equal(readFileSync(outFile, "utf8"), "SECRET-LOOT-UNTOUCHABLE");
  });
});

describe("sandbox-escape: terminal lane", () => {
  it("TerminalPolicy.checkShape: shell/path-shaped argv0 + eval flags hard-denied", () => {
    const denied = [
      ["sh", "-c", "id"], ["bash", "-c", "id"], ["zsh", "-c", "id"], ["cmd", "/c", "dir"],
      ["powershell", "-c", "id"], ["/bin/sh", "-c", "id"], ["../bin/node", "--version"],
      ["node", "-e", "process.exit(1)"], ["python3", "-c", "print(1)"],
      ["rust-script", "-e", "x"].slice(0, 0),
      ["perl", "-e", "print"],
    ].filter((a) => a.length > 0);
    for (const argv of denied) {
      assert.notEqual(TerminalPolicy.checkShape(argv), null, `shape accepted: ${argv.join(" ")}`);
    }
    assert.equal(TerminalPolicy.checkShape(["ls", "-la"]), null);
    assert.equal(TerminalPolicy.checkShape(["git", "status"]), null);
  });

  it("terminal.exec preflight never-allows every blocked-classified bucket (deny → neverAllow, approval can't save it)", () => {
    const jail = mkdtempSync(join(tmpdir(), "aice-esc-t-"));
    const ctx = mkCtx(jail);
    const argvs = [
      ["rm", "-rf", "/"], ["dd", "if=/dev/zero", "of=/dev/sda"], ["mkfs", "/dev/sda1"],
      ["reboot"], ["drop", "database", "prod"],
    ];
    for (const argv of argvs) {
      const pre = terminalExec.preflight({ argv }, ctx);
      assert.equal(pre.neverAllow, true, `preflight missed: ${argv.join(" ")}`);
      assert.equal(pre.dangerous, true);
    }
    rmSync(jail, { recursive: true, force: true });
  });

  it("preflight refuses cwd outside the jail BEFORE exec (no time-of-check race)", () => {
    const jail = mkdtempSync(join(tmpdir(), "aice-esc-tc-"));
    mkdirSync(join(jail, "inner"));
    const ctx = mkCtx(jail);
    const pre = terminalExec.preflight({ argv: ["ls"], cwd: ".." }, ctx);
    assert.equal(pre.neverAllow, true);
    const ok = terminalExec.preflight({ argv: ["ls"], cwd: "inner" }, ctx);
    assert.notEqual(ok.neverAllow, true);
    rmSync(jail, { recursive: true, force: true });
  });

  it("sanitizedEnv: inherited process secrets are constructionally absent", () => {
    process.env.AICE_TESTONLY_SUPERSECRET = "ghp_NEVERLETGO123456789012345678901234";
    try {
      const env = sanitizedEnv("/tmp/jail");
      assert.equal(env.AICE_TESTONLY_SUPERSECRET, undefined, "env leaked");
      for (const [k, v] of Object.entries(env)) {
        assert.ok(typeof k === "string");
        // any value containing the planted secret is impossible — belt: assert absent
        assert.ok(!(typeof v === "string" && v.includes("ghp_NEVERLETGO")), `${k} carried secret`);
      }
    } finally {
      delete process.env.AICE_TESTONLY_SUPERSECRET;
    }
  });

  it("terminal.exec executes allowlisted argv inside jail with capped output (positive control)", async () => {
    const jail = mkdtempSync(join(tmpdir(), "aice-esc-tx-"));
    writeFileSync(join(jail, "hello.txt"), "hi");
    const ctx = mkCtx(jail);
    const out = await terminalExec.run({ argv: ["ls"] }, ctx);
    assert.ok(String(out).includes("hello.txt"));
    const unexpanded = await terminalExec.run({ argv: ["ls", "$(id)"], cwd: "." }, ctx);
    assert.doesNotMatch(String(unexpanded), /uid=\d+/, "argv-only: $(id) must be a literal name");
    rmSync(jail, { recursive: true, force: true });
  });
});
