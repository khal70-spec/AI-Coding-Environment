// Unit: fs.* tools — jail containment (lexical + symlink), read caps, safe-edit
// literal replace semantics, policy read-vs-write scope split (T9).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, type as osType } from "node:os";
import { join } from "node:path";
import { ToolRunner } from "../../../packages/tools/src/runtime.ts";
import { FS_TOOLS } from "../../../packages/tools/src/fs-tools.ts";

const NUL = String.fromCharCode(0);
const FAKE_GH = ["g", "h", "p_"].join("") + "B".repeat(24) + "-TESTONLY";

function untag(output) {
  const lines = output.split("\n");
  assert.ok(lines[0].startsWith("<<<UNTRUSTED-TOOL-OUTPUT"));
  assert.equal(lines[lines.length - 1], "<<<END-UNTRUSTED-TOOL-OUTPUT>>>");
  return lines.slice(1, -1).join("\n");
}

const GRANT = {
  toolsAllow: ["*"],
  toolsDeny: [],
  fsRead: "workspace",
  fsWrite: "workspace",
  terminal: "approved_commands",
  networkDefault: "deny",
  networkAllow: [],
  maxRisk: "high",
  maxClassification: "confidential",
};
const PCTX = { workspaceLocked: false, providerMaxClassification: "confidential" };

function setup() {
  const root = mkdtempSync(join(tmpdir(), "aice-fs-"));
  writeFileSync(join(root, "a.txt"), "hello world\nsecond line\n");
  writeFileSync(join(root, "big.bin"), `head${NUL}binary-tail`);
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "sub", "b.txt"), "sub file content\nhello again\n");
  mkdirSync(join(root, "node_modules"));
  writeFileSync(join(root, "node_modules", "junk.js"), "hello in vendorland\n");
  const runner = new ToolRunner(FS_TOOLS);
  const ctx = (grant = GRANT, approved = false) => ({
    actor: "agent:tester",
    risk: "low",
    classification: "public",
    grant,
    policyCtx: PCTX,
    jailRoot: root,
    ...(approved ? { approved: true } : {}),
  });
  const call = (tool, args, grant, approved = false) =>
    runner.call({ tool, args, cwd: root, risk: "low", classification: "public" }, ctx(grant, approved));
  return { root, call, body: (res) => untag(res.output) };
}

describe("fs.read", () => {
  it("reads a file relative to the workspace", async () => {
    const { call, body } = setup();
    const res = await call("fs.read", { path: "a.txt" });
    assert.equal(res.ok, true);
    assert.match(body(res), /hello world/);
  });

  it("reads via absolute-in-jail path", async () => {
    const { root, call, body } = setup();
    const res = await call("fs.read", { path: join(root, "sub", "b.txt") });
    assert.equal(res.ok, true);
    assert.match(body(res), /sub file content/);
  });

  it("refuses lexical escapes (../..)", async () => {
    const { call } = setup();
    const res = await call("fs.read", { path: "../../../../etc/passwd" });
    assert.equal(res.ok, false);
    assert.equal(res.code, "JAIL_ESCAPE");
  });

  it("refuses absolute paths outside the jail", async () => {
    const { call } = setup();
    const res = await call("fs.read", { path: "/etc/shadow" });
    assert.equal(res.ok, false);
    assert.equal(res.code, "JAIL_ESCAPE");
  });

  it("refuses binary files", async () => {
    const { call } = setup();
    const res = await call("fs.read", { path: "big.bin" });
    assert.equal(res.code, "EXECUTION_FAILED");
    assert.match(String(untag(res.output)), /binary file/);
  });

  it("reports missing files", async () => {
    const { call } = setup();
    const res = await call("fs.read", { path: "nope.txt" });
    assert.equal(res.code, "EXECUTION_FAILED");
  });

  it("requires a read scope grant (POLICY_DENIED when fsRead=none)", async () => {
    const { call } = setup();
    const res = await call("fs.read", { path: "a.txt" }, { ...GRANT, fsRead: "none" });
    assert.equal(res.code, "POLICY_DENIED");
  });
});

describe("fs.list", () => {
  it("lists workspace entries, skipping node_modules by default", async () => {
    const { call, body } = setup();
    const res = await call("fs.list", { path: "." });
    assert.equal(res.ok, true);
    const b = body(res);
    assert.match(b, /f\ta\.txt/);
    assert.match(b, /d\tsub/);
    assert.doesNotMatch(b, /junk\.js/);
  });

  it("descends one extra level with depth=2", async () => {
    const { call, body } = setup();
    const res = await call("fs.list", { path: ".", depth: 2 });
    assert.match(body(res), /sub\/b\.txt/);
  });

  it("marks out-of-jail symlinks without following them", { skip: osType() === "Windows_NT" }, async () => {
    const { root, call, body } = setup();
    symlinkSync("/etc", join(root, "link-etc"), "dir");
    const res = await call("fs.list", { path: "." });
    assert.match(body(res), /S\tlink-etc/);
  });
});

describe("fs.write", () => {
  it("creates a new file", async () => {
    const { root, call } = setup();
    const res = await call("fs.write", { path: "new.txt", content: "fresh bytes" });
    assert.equal(res.ok, true);
    assert.equal(readFileSync(join(root, "new.txt"), "utf8"), "fresh bytes");
  });

  it("overwrite is dangerous → approval gate, file untouched", async () => {
    const { root, call } = setup();
    const res = await call("fs.write", { path: "a.txt", content: "clobbered" });
    assert.equal(res.code, "APPROVAL_REQUIRED");
    assert.match(readFileSync(join(root, "a.txt"), "utf8"), /hello world/);
  });

  it("append is not dangerous and appends", async () => {
    const { root, call } = setup();
    const res = await call("fs.write", { path: "a.txt", content: "\nthird line\n", append: true });
    assert.equal(res.ok, true);
    assert.match(readFileSync(join(root, "a.txt"), "utf8"), /third line/);
  });

  it("hard-denies escape writes via preflight neverAllow", async () => {
    const { root, call } = setup();
    const res = await call("fs.write", { path: join(root, "..", "outside-wedge.txt"), content: "x" });
    assert.equal(res.code, "POLICY_DENIED");
    assert.equal(existsSync(join(root, "..", "outside-wedge.txt")), false);
  });

  it("secret-shaped content is flagged dangerous (approval + never written)", async () => {
    const { root, call } = setup();
    const res = await call("fs.write", { path: "conf.txt", content: `key=${FAKE_GH}` });
    assert.equal(res.code, "APPROVAL_REQUIRED");
    assert.equal(existsSync(join(root, "conf.txt")), false);
  });

  it("createParents builds nested dirs inside the jail", async () => {
    const { root, call } = setup();
    const res = await call("fs.write", { path: "deep/nest/file.txt", content: "d", createParents: true });
    assert.equal(res.ok, true);
    assert.equal(readFileSync(join(root, "deep", "nest", "file.txt"), "utf8"), "d");
  });

  it("mising parent without createParents fails cleanly", async () => {
    const { call } = setup();
    const res = await call("fs.write", { path: "no/dir/x.txt", content: "d" });
    assert.equal(res.code, "EXECUTION_FAILED");
  });

  it("requires a write scope grant (POLICY_DENIED when fsWrite=none)", async () => {
    const { call } = setup();
    const res = await call("fs.write", { path: "new2.txt", content: "x" }, { ...GRANT, fsWrite: "none" });
    assert.equal(res.code, "POLICY_DENIED");
  });
});

describe("fs.edit (literal search/replace)", () => {
  it("replaces a unique literal match", async () => {
    const { root, call } = setup();
    const res = await call("fs.edit", { path: "a.txt", search: "hello world", replace: "bye world" }, undefined, true);
    assert.equal(res.ok, true);
    assert.match(readFileSync(join(root, "a.txt"), "utf8"), /bye world/);
  });

  it("refuses ambiguous first-match edits by default", async () => {
    const { root, call } = setup();
    writeFileSync(join(root, "multi.txt"), "dup dup dup\n");
    const res = await call("fs.edit", { path: "multi.txt", search: "dup", replace: "x" }, undefined, true);
    assert.equal(res.code, "EXECUTION_FAILED");
    assert.match(String(untag(res.output)), /ambiguous edit: 3 matches/);
    assert.equal(readFileSync(join(root, "multi.txt"), "utf8"), "dup dup dup\n");
  });

  it("occurrence=all replaces every match", async () => {
    const { root, call } = setup();
    writeFileSync(join(root, "multi.txt"), "dup dup dup\n");
    const res = await call("fs.edit", {
      path: "multi.txt",
      search: "dup",
      replace: "x",
      occurrence: "all",
      requireUniqueMatch: false,
    }, undefined, true);
    assert.equal(res.ok, true);
    assert.equal(readFileSync(join(root, "multi.txt"), "utf8"), "x x x\n");
  });

  it("no match → clean failure, file untouched", async () => {
    const { root, call, body } = setup();
    const res = await call("fs.edit", { path: "a.txt", search: "not present", replace: "y" }, undefined, true);
    assert.equal(res.code, "EXECUTION_FAILED");
    assert.match(body(res), /search string not found/);
    assert.match(readFileSync(join(root, "a.txt"), "utf8"), /hello world/);
  });

  it("never treats search as regex (dots are literal)", async () => {
    const { root, call } = setup();
    // "h.llo" as regex would match "hello"; as literal it must not.
    const res = await call("fs.edit", { path: "a.txt", search: "h.llo", replace: "x" }, undefined, true);
    assert.equal(res.code, "EXECUTION_FAILED");
    assert.match(readFileSync(join(root, "a.txt"), "utf8"), /hello world/);
  });

  it("is gated as dangerous by policy (approval) before touching disk", async () => {
    // preflight marks fs.edit dangerous; verify an approval-gated call doesn't write
    const { root, call } = setup();
    writeFileSync(join(root, "sub", "c.txt"), "stays\n");
    const res = await call("fs.edit", { path: "sub/c.txt", search: "stays", replace: "goes" });
    assert.equal(res.code, "APPROVAL_REQUIRED");
    assert.equal(readFileSync(join(root, "sub", "c.txt"), "utf8"), "stays\n");
  });
});

describe("fs.search", () => {
  it("finds literal matches with file:line:content", async () => {
    const { call, body } = setup();
    const res = await call("fs.search", { pattern: "hello" });
    assert.equal(res.ok, true);
    const b = body(res);
    assert.match(b, /a\.txt:1: hello world/);
    assert.match(b, /sub\/b\.txt:2: hello again/);
  });

  it("supports regex metacharacters properly", async () => {
    const { call, body } = setup();
    const res = await call("fs.search", { pattern: "l+o" });
    assert.match(body(res), /a\.txt:1: hello world/);
  });

  it("rejects invalid regexes cleanly", async () => {
    const { call } = setup();
    const res = await call("fs.search", { pattern: "([unclosed" });
    assert.equal(res.code, "VALIDATION_ERROR");
  });

  it("caps results at maxResults", async () => {
    const { root, call, body } = setup();
    for (let i = 0; i < 30; i++) writeFileSync(join(root, `m${i}.txt`), "needle needle\nneedle\n");
    const res = await call("fs.search", { pattern: "needle", maxResults: 10 });
    const b = body(res);
    assert.match(b, /matches: 10 \(capped\)/);
    const rows = b.split("\n").filter((l) => /^m\d+\.txt:\d+:/.test(l) || /a\.txt/.test(l) || /b\.txt/.test(l));
    assert.ok(rows.length <= 11);
  });

  it("skips binary files rather than dumping them", async () => {
    const { call, body } = setup();
    const res = await call("fs.search", { pattern: "binary-tail" });
    assert.equal(res.ok, true);
    assert.doesNotMatch(body(res), /big\.bin/);
  });
});
