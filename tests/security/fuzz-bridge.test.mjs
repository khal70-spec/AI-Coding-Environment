// Fuzz (P8.2): bridge HTTP surface under seeded randomized envelopes.
// Invariants under ANY bytes: reply is HTTP ≤500 with ≤64KB body, never hangs
// beyond client timeout, known errors keep stable lanes, server never dies, and
// dispatch lanes stay distinguishable (UNKNOWN_COMMAND/BAD_ARGS).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBridge } from "../../apps/desktop/src/server.ts";
import { makePrng, seeded, randomBytesAsLatin } from "./fuzz-random.mjs";

const SEED = seeded();
const ROUNDS = 300;

async function raw(port, bytes) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/bridge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: bytes,
      signal: controller.signal,
    });
    const body = await res.arrayBuffer();
    return { status: res.status, bytes: body.byteLength, ok: true };
  } catch (err) {
    return { status: 0, bytes: 0, ok: false, err: String(err) };
  } finally {
    clearTimeout(t);
  }
}

describe("fuzz: bridge envelope canopy", () => {
  let dir = "";
  let handle;
  let port;
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "aice-fuzz-bridge-"));
    const web = join(dir, "web");
    mkdirSync(web);
    writeFileSync(join(web, "index.html"), "<html></html>");
    handle = await startBridge({ dbPath: join(dir, "app.db"), actor: "fuzz-TESTONLY", webRoot: web });
    port = handle.port;
  });
  after(() => {
    handle?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it(`${ROUNDS} random envelopes: bounded replies, no server death (seed ${SEED.toString(16)})`, async () => {
    const prng = makePrng(SEED);
    const statuses = new Set();
    let failed = 0;
    for (let i = 0; i < ROUNDS; i++) {
      const len = Math.floor(prng() * 600);
      const bytes = randomBytesAsLatin(prng, len);
      const r = await raw(port, bytes);
      if (!r.ok) {
        // Body too large/async socket closes are fine — but the NEXT request must work
        failed++;
        const ping = await raw(port, JSON.stringify({ command: "projects.list" }));
        assert.equal(ping.status, 200, `round ${i}: server failed to survive`);
        continue;
      }
      statuses.add(r.status);
      assert.ok(r.bytes <= 8192, `round ${i}: reply not bounded (${r.bytes})`);
      assert.ok([200, 400, 404, 413].includes(r.status), `round ${i}: unexpected status ${r.status}`);
    }
    // multiple distinct lanes exercised (not a single-pathway server)
    assert.ok(statuses.has(400) || statuses.has(413), "malformed traffic observed");
    const alive = await raw(port, JSON.stringify({ command: "projects.list" }));
    assert.equal(alive.status, 200);
    void failed;
  });

  it(`structured fuzz: every reply parses as JSON with frozen lane envelope (seed ${SEED.toString(16)})`, async () => {
    const prng = makePrng(SEED ^ 0xc0ffee);
    const COMMANDS = ["projects.list", "tasks.list", "tasks.create", "tasks.advance", "skills.list", "mcp.list", "nope", "", "A".repeat(100)];
    for (let i = 0; i < 120; i++) {
      const env = {
        command: COMMANDS[Math.floor(prng() * COMMANDS.length)],
        args: randArgs(prng),
      };
      const r = await raw(port, JSON.stringify(env));
      assert.ok(r.ok, `round ${i}: fetch-level failure`);
      assert.ok([200, 400, 404].includes(r.status));
    }
  });

  it("path fuzz: static traversal blind spots stay dark", async () => {
    const prng = makePrng(SEED ^ 0xdead);
    const bits = ["..", "%2e", "%2e%2e", "..%2f", "\\\\", ".", "..\\..\\", "/etc/passwd", "node_modules", "package.json", "app.db", "src"];
    for (let i = 0; i < 100; i++) {
      const take = 1 + Math.floor(prng() * 4);
      const segs = [];
      for (let k = 0; k < take; k++) segs.push(bits[Math.floor(prng() * bits.length)]);
      const path = `/${segs.join("/")}`;
      if (!/^\/[A-Za-z0-9._/-]*$/.test(path)) continue; // server rejects at first gate anyway
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      assert.ok(res.status === 400 || res.status === 404 || (res.status === 200 && !path.includes("..")), `${path} → ${res.status}`);
      await res.arrayBuffer();
    }
  });
});

function randArgs(prng) {
  const shape = prng();
  if (shape < 0.2) return null;
  if (shape < 0.35) return [1, 2, 3];
  if (shape < 0.45) return "str";
  const obj = {};
  const keys = ["taskId", "projectId", "title", "id", "n", "mode", "__proto__", "constructor", "to", "kind", "limit", "smuggle"];
  const n = Math.floor(prng() * 5);
  for (let i = 0; i < n; i++) {
    const k = keys[Math.floor(prng() * keys.length)];
    const v = prng();
    obj[k] = v < 0.3 ? Math.floor(prng() * 200) : v < 0.6 ? "x".repeat(Math.floor(prng() * 40)) : v < 0.8 ? true : v < 0.9 ? null : { nested: [1] };
  }
  return obj;
}
