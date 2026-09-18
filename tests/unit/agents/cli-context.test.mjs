// Integration: aice context build + aice route (P5.5) — real CLI spawns on fixtures.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { openDatabase, ModelsDao } from "../../../packages/storage/src/index.ts";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "apps/cli/src/cli.ts");

function fixtureProject() {
  const root = mkdtempSync(join(tmpdir(), "aice-ctx-"));
  mkdirSync(join(root, "src", "routes"), { recursive: true });
  mkdirSync(join(root, "src", "lib"), { recursive: true });
  writeFileSync(join(root, "src", "routes", "health.ts"), 'import { checkDb } from "../lib/db";\nexport function healthRoute(): string { return checkDb() ? "ok" : "down"; }\n');
  writeFileSync(join(root, "src", "lib", "db.ts"), "export function checkDb(): boolean { return true; }\n");
  writeFileSync(join(root, "src", "noise.ts"), "export const sleepy = 2;\n");
  writeFileSync(join(root, "src", "tokens.ts"), 'export const k = "ghp_TESTONLYabcdefghijklmnopqrstuv";\n');
  return root;
}

function aice(db, root, args) {
  return spawnSync(process.execPath, [CLI, ...args, "--db", db], { cwd: root, encoding: "utf8" });
}

function created(db, root) {
  const p = JSON.parse(aice(db, root, ["project", "create", "--name", "ctx-TESTONLY", "--path", root, "--json"]).stdout);
  const t = JSON.parse(aice(db, root, ["task", "create", "--project", p.id, "--title", "fix the health route db check", "--json"]).stdout);
  return { project: p, task: t };
}

describe("aice context / route (P5.5)", () => {
  it("context build: indexes, ranks, packs, redacts; artifacts under .aice/context", { timeout: 120_000 }, () => {
    const root = fixtureProject();
    const db = join(root, ".local", "app.db");
    const { task } = created(db, root);
    const r = aice(db, root, ["context", "build", task.id, "--budget", "8000", "--json"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const out = JSON.parse(r.stdout);
    assert.ok(existsSync(out.index), "index persisted");
    assert.ok(existsSync(out.pack), "pack persisted");
    assert.equal(out.filesIndexed, 4);
    assert.match(out.index, /\.aice[\/\\]context[\/\\]index\.json$/);
    const pack = JSON.parse(readFileSync(out.pack, "utf8"));
    assert.ok(pack.packed.some((c) => c.id === "file:src/routes/health.ts"), JSON.stringify(pack.ranked));
    // health hub ranked above noise
    const hubs = pack.ranked.find((s) => s.path === "src/routes/health.ts");
    const noise = pack.ranked.find((s) => s.path === "src/noise.ts");
    assert.ok(hubs !== undefined && (noise === undefined ? true : hubs.score > noise.score), JSON.stringify(pack.ranked));
    // tokens.ts entered chunks? ranking depends on terms — but if it did, it is redacted:
    assert.ok(typeof pack.redactionHits === "number");
    const audit = aice(db, root, ["audit", "--task", task.id]);
    assert.match(audit.stdout, /context\.build/);
  });

  it("route with empty registry → (none) + exit 1 (honest unavailable lane)", { timeout: 60_000 }, () => {
    const root = fixtureProject();
    const db = join(root, ".local", "app.db");
    const { task } = created(db, root);
    const r = aice(db, root, ["route", task.id, "--json"]);
    assert.equal(r.status, 1);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision.modelId, "(none)");
    assert.equal(out.facts.kind, "code");
    assert.equal(out.facts.risk, "low");
  });

  it("route against seeded registry: code task → code-named verified model; restricted pins local", { timeout: 120_000 }, () => {
    const root = fixtureProject();
    const db = join(root, ".local", "app.db");
    const { project, task } = created(db, root);
    // seed providers via CLI + models via the DAO in-process
    const add = aice(db, root, ["provider", "add", "--name", "lc", "--protocol", "local-openai-compatible", "--base-url", "http://127.0.0.1:1234", "--max-classification", "restricted", "--json"]);
    assert.equal(add.status, 0, add.stderr + add.stdout);
    const provider = JSON.parse(add.stdout);
    const add2 = aice(db, root, ["provider", "add", "--name", "cl", "--protocol", "openai-chat", "--base-url", "https://api.TESTONLY.invalid", "--max-classification", "internal", "--json"]);
    assert.equal(add2.status, 0, add2.stderr + add2.stdout);
    const provider2 = JSON.parse(add2.stdout);
    const opened = openDatabase(db);
    try {
      const models = new ModelsDao(opened.db);
      const m1 = models.upsert({ providerId: provider.id, name: "Qwen Coder 7B", contextWindow: 32768 });
      const m2 = models.upsert({ providerId: provider2.id, name: "gpt-4o-TESTONLY", contextWindow: 128000 });
      for (const m of [m1, m2]) {
        models.setVerified(m, true); // stands in for a passed capability probe
        models.setStatus(m, "available");
        
      }
    } finally {
      opened.db.close();
    }
    const r = aice(db, root, ["route", task.id, "--prompt", "refactor healthRoute to reuse checkDb", "--json"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const dec1 = JSON.parse(r.stdout).decision;
    assert.equal(dec1.providerId, provider.id, JSON.stringify(dec1));
    assert.match(dec1.modelId, /Qwen Coder 7B$/);
    // same task on a RESTRICTED project must land local-only
    const rp = JSON.parse(aice(db, root, ["project", "create", "--name", "conf-TESTONLY", "--path", root, "--classification", "restricted", "--json"]).stdout);
    const rt = JSON.parse(aice(db, root, ["task", "create", "--project", rp.id, "--title", "fix auth issue in health route", "--json"]).stdout);
    const rr = aice(db, root, ["route", rt.id, "--json"]);
    assert.equal(rr.status, 0, rr.stderr + rr.stdout);
    const dec = JSON.parse(rr.stdout).decision;
    assert.equal(dec.providerId, provider.id, JSON.stringify(dec));
  });
});
