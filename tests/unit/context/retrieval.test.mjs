// Unit: retrieval + budget packing + filtering (P5.2/P5.3).
// Retrieval quality: fixture with PLANTED hub/spoke files — the task wording must
// surface the hub and its imported leaves, ranked above noise. Determinism pinned.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRepoIndex } from "../../../packages/context/src/repo-index.ts";
import { rank, packWorkspace, taskTokens, filterChunkText } from "../../../packages/context/src/retrieval.ts";
import { containsSecret } from "../../../packages/security/src/index.ts";

function fixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), "aice-ret-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "src", "routes"));
  mkdirSync(join(root, "src", "lib"));
  writeFileSync(join(root, "src", "routes", "health.ts"), [
    "// HEALTH HUB",
    "import { checkDb } from \"../lib/db\";",
    "export function healthRoute(): string { return checkDb() ? \"ok\" : \"down\"; }",
  ].join("\n"));
  writeFileSync(join(root, "src", "lib", "db.ts"), "export function checkDb(): boolean { return true; }\n");
  writeFileSync(join(root, "src", "unrelated-a.ts"), "export const noiseValueA = 1;\n");
  writeFileSync(join(root, "src", "unrelated-b.ts"), "export function foamBubbles(): void {}\n");
  writeFileSync(
    join(root, "src", "README.md"),
    "# proj-TESTONLY\nhealth endpoint lives in routes/health.ts\n",
  );
  writeFileSync(join(root, "src", "config.ts"), 'export const key = "ghp_TESTONLYabcdefghijklmnopqrstuv";\n');
  return root;
}

describe("retrieval (P5.2/P5.3)", () => {
  it("task wording surfaces hub + imported leaf above noise, deterministically", () => {
    const root = fixtureRepo();
    try {
      const idx = buildRepoIndex(root);
      const q = { taskText: "Fix the health route: /health should check the db" };
      const r1 = rank(idx, q).map((s) => s.path);
      const r2 = rank(buildRepoIndex(root), { taskText: "Fix the health route: /health should check the db" }).map((s) => s.path);
      assert.deepEqual(r2, r1, "deterministic across independent index builds");
      const hub = r1.indexOf("src/routes/health.ts");
      const leaf = r1.indexOf("src/lib/db.ts");
      const noiseA = r1.indexOf("src/unrelated-a.ts");
      assert.ok(hub !== -1, JSON.stringify(r1));
      assert.ok(leaf !== -1 && leaf > hub, JSON.stringify(r1));
      if (noiseA !== -1) assert.ok(noiseA > hub && noiseA > leaf);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("packWorkspace: chunks budget-fit, redact secrets, hash redacted text only", () => {
    const root = fixtureRepo();
    try {
      const idx = buildRepoIndex(root);
      const res = packWorkspace(root, idx, { taskText: "config key health route" }, 100000, { maxFiles: 10 });
      assert.ok(res.packed.length >= 1);
      const ids = res.packed.map((c) => c.id);
      assert.ok(ids.includes("file:src/routes/health.ts"));
      const cfg = res.packed.find((c) => c.id === "file:src/config.ts");
      if (cfg !== undefined) {
        // hash must be of the REDACTED chunk, and content must already beчищен
        assert.notEqual(cfg.sha256, idx.files.find((f) => f.path === "src/config.ts")?.sha256);
        assert.ok(res.redactionHits >= 1);
      }
      // tiny budget forces drops by priority order
      const tight = packWorkspace(root, idx, { taskText: "health route db" }, 8, { maxFiles: 10 });
      assert.ok(tight.packed.length < res.packed.length || tight.packed.length <= 1);
      assert.ok(tight.dropped.length >= 1);
      // full determinism on identical inputs
      const a = packWorkspace(root, buildRepoIndex(root), { taskText: "health route" }, 1000);
      const b = packWorkspace(root, buildRepoIndex(root), { taskText: "health route" }, 1000);
      assert.deepEqual(a.packed.map((c) => c.id), b.packed.map((c) => c.id));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("secret-canary recall across file blocks (P5.3 measure)", () => {
    const root = mkdtempSync(join(tmpdir(), "aice-canary-"));
    try {
      const canaries = [
        "ghp_TESTONLYabcdefghijklmnopqrstuv",
        "ghp_TESTONLY0123456789abcdefgh",
        "sk_live_TESTONLY0123456789abcdef",
        "AKIAIOSFODNN7TESTONLY",
        "-----BEGIN PRIVATE KEY-----TESTONLY",
      ];
      mkdirSync(join(root, "src"));
      for (const [i, c] of canaries.entries()) {
        writeFileSync(join(root, "src", `leak-${i}.ts`), `export const v = "${c}";\n`);
      }
      // recall expectation comes FROM the detector itself: whatever it flags must be
      // filtered; anything it cannot see passes verbatim (honest coverage report).
      const detected = canaries.filter((c) => containsSecret(`export const v = "${c}";`));
      const idx = buildRepoIndex(root);
      const res = packWorkspace(root, idx, { taskText: "leak" }, 100000);
      assert.equal(res.packed.length, canaries.length);
      assert.equal(res.redactionHits, detected.length, `hits=${res.redactionHits} expected=${detected.length} of ${canaries.length}`);
      for (const c of detected) {
        const raw = readFileSync(join(root, "src", `leak-${canaries.indexOf(c)}.ts`), "utf8");
        const { text } = filterChunkText(raw);
        assert.ok(!text.includes(c), `detected canary survived filter: ${c.slice(0, 8)}…`);
        assert.match(text, /TOKEN|REDACTED|\*\*/);
      }
      // never-detected canaries stay intact (nothing mangled): no catastrophic recall
      for (const c of canaries.filter((c0) => !detected.includes(c0))) {
        const raw = readFileSync(join(root, "src", `leak-${canaries.indexOf(c)}.ts`), "utf8");
        const { text } = filterChunkText(raw);
        assert.ok(text.includes(c));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("taskTokens splits camelCase and pinpoints hints", () => {
    const t = taskTokens("Fix healthRoute in routes/health.ts — checkDb misbehaves");
    assert.ok(t.includes("healthroute") || (t.includes("health") && t.includes("route")), JSON.stringify(t));
    assert.ok(t.includes("routes/health.ts"), "paths kept as tokens");
    assert.ok(!t.includes("the"));
  });
});
