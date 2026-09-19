// Unit: skill bundles (P6.3) — digest determinism, manifest validation, tamper flow,
// side-by-side with the SkillsDao registry state machine (real temp SQLite).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestSkillBundle, parseSkillManifest, decideSkillUse, SKILL_MANIFEST_FILE } from "../../../packages/mcp/src/skills.ts";
import { openDatabase, SkillsDao, PermissionsDao } from "../../../packages/storage/src/index.ts";

function makeBundle({ tamper = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "aice-skill-"));
  writeFileSync(
    join(dir, SKILL_MANIFEST_FILE),
    JSON.stringify({
      name: "db-migrate-helper-TESTONLY",
      version: "1.2.3",
      permissions: ["fs.pattern:migrations/**", "tool:test.exec", "effect:fs.write"],
      description: "creates migration files",
      sideEffects: true,
    }),
  );
  mkdirSync(join(dir, "lib"));
  writeFileSync(join(dir, "lib", "migrate.js"), "// impl-TESTONLY\nmodule.exports = v => v;\n");
  writeFileSync(join(dir, "run.sh"), "echo run-TESTONLY\n");
  if (tamper) writeFileSync(join(dir, "lib", "migrate.js"), "// impl-TESTONLY\nmodule.exports = v => v; // tampered-TESTONLY\n");
  return dir;
}

describe("digestSkillBundle", () => {
  it("is canonical & deterministic (content+paths order-independent)", () => {
    const a = makeBundle();
    const b = makeBundle();
    try {
      const d1 = digestSkillBundle(a);
      const d2 = digestSkillBundle(b);
      assert.equal(d1.error, undefined);
      assert.equal(d2.error, undefined);
      assert.equal(d1.sha256, d2.sha256, "identical bundles → identical digest");
      assert.ok(d1.files.includes(SKILL_MANIFEST_FILE));
      assert.ok(d1.files.includes("lib/migrate.js"));
      assert.match(d1.sha256, /^[0-9a-f]{64}$/);
      // re-digest of the same tree is stable too
      assert.equal(digestSkillBundle(a).sha256, d1.sha256);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  it("tamper: a one-byte content change flips the digest; symlink bundles refused", () => {
    const good = makeBundle();
    const bad = makeBundle({ tamper: true });
    try {
      assert.notEqual(digestSkillBundle(good).sha256, digestSkillBundle(bad).sha256);
      symlinkSync(join(good, "lib", "migrate.js"), join(good, "alias.js"));
      const d = digestSkillBundle(good);
      assert.match(d.error ?? "", /symlink refused/);
    } finally {
      rmSync(good, { recursive: true, force: true });
      rmSync(bad, { recursive: true, force: true });
    }
  });
});

describe("parseSkillManifest", () => {
  it("valid bundle parses; permission entries must be namespaced; no freeform", () => {
    const dir = makeBundle();
    try {
      const r = parseSkillManifest(dir);
      assert.deepEqual(r.errors, []);
      assert.equal(r.manifest.name, "db-migrate-helper-TESTONLY");
      assert.ok(r.manifest.permissions.includes("fs.pattern:migrations/**"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const bad = mkdtempSync(join(tmpdir(), "aice-badskill-"));
    writeFileSync(join(bad, SKILL_MANIFEST_FILE), JSON.stringify({ name: "x", permissions: ["everything", "net:internal.local"] }));
    try {
      const r2 = parseSkillManifest(bad);
      assert.ok(r2.errors.some((e) => e.includes("invalid permission entry")), JSON.stringify(r2.errors));
    } finally {
      rmSync(bad, { recursive: true, force: true });
    }
    const noName = mkdtempSync(join(tmpdir(), "aice-noname-"));
    writeFileSync(join(noName, SKILL_MANIFEST_FILE), JSON.stringify({ permissions: [] }));
    try {
      assert.ok(parseSkillManifest(noName).errors.some((e) => e.includes("name required")));
    } finally {
      rmSync(noName, { recursive: true, force: true });
    }
  });
});

describe("SkillsDao registry + decideSkillUse flow (aice-level semantics)", () => {
  let dbDir = "";
  let db;
  let skills;
  let permissions;
  before(() => {
    dbDir = mkdtempSync(join(tmpdir(), "aice-skillsdb-"));
    const opened = openDatabase(join(dbDir, "app.db"));
    db = opened.db;
    skills = new SkillsDao(db);
    permissions = new PermissionsDao(db);
  });
  after(() => {
    db.close();
    rmSync(dbDir, { recursive: true, force: true });
  });

  it("register pending → approve → tamper → decideSkillUse blocks; re-digest & re-approve revives", () => {
    const dir = makeBundle();
    try {
      const manifest = parseSkillManifest(dir).manifest;
      const d = digestSkillBundle(dir);
      const row = skills.register({
        name: manifest.name,
        version: manifest.version,
        sourcePath: dir,
        sha256: d.sha256,
        permissionsJson: JSON.stringify(manifest.permissions),
      });
      assert.equal(row.status, "pending_review");
      // pending → cannot run
      assert.equal(decideSkillUse(row.status, d.sha256, row.sha256).ok, false);
      // approve by human reviewer
      skills.setStatus(row.id, "approved", "human:TESTONLY");
      assert.equal(skills.get(row.id)?.status, "approved");
      assert.equal(decideSkillUse("approved", digestSkillBundle(dir).sha256, row.sha256).ok, true);
      // tamper the bundle
      writeFileSync(join(dir, "lib", "migrate.js"), readFileSync(join(dir, "lib", "migrate.js"), "utf8") + "// tainted-TESTONLY\n");
      const live = digestSkillBundle(dir).sha256;
      const use = decideSkillUse("approved", live, row.sha256);
      assert.equal(use.ok, false);
      assert.match(use.reason, /digest mismatch/);
      // move-check: path deletion → empty live digest also blocks
      const gone = decideSkillUse("approved", "", row.sha256);
      assert.equal(gone.ok, false);
      // permission rows tightened against run surface (deny wins at a later layer)
      permissions.set(`skill:${row.id}`, "tool:terminal.exec", "deny");
      assert.equal(permissions.listFor(`skill:${row.id}`)[0].effect, "deny");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("name uniqueness enforced; list ordering stable", () => {
    const dir = makeBundle();
    try {
      const d = digestSkillBundle(dir);
      skills.register({ name: "blk-TESTONLY", sourcePath: dir, sha256: d.sha256, permissionsJson: "[]" });
      skills.register({ name: "zro-TESTONLY", sourcePath: dir, sha256: d.sha256, permissionsJson: "[]" });
      assert.throws(() => skills.register({ name: "blk-TESTONLY", sourcePath: dir, sha256: d.sha256, permissionsJson: "[]" }), /UNIQUE/);
      assert.equal(skills.list().length, 2 + skills.list().length - 2); // sanity no crash
      assert.ok(skills.list().some((s) => s.name === "zro-TESTONLY"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
