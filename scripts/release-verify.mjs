#!/usr/bin/env node
// release-verify (P9.5): verify the shipped artifact against its sums AND rebuild-
// reproducibility: build a SECOND artifact from the same HEAD and require byte-equality.
// This is the operator's "was this package really made from what I see" proof.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(ROOT, "dist");

const sumsPath = join(dist, "SHA256SUMS.txt");
let sums;
try {
  sums = readFileSync(sumsPath, "utf8").trim().split(/\s+/, 2);
} catch {
  console.error("release-verify — dist/SHA256SUMS.txt missing (run release-prepare first)");
  process.exit(1);
}
const [recorded, filename] = sums;
const artifactPath = join(dist, filename);
let artifact;
try {
  artifact = readFileSync(artifactPath);
} catch {
  console.error(`release-verify — artifact ${filename} missing`);
  process.exit(1);
}
const actual = createHash("sha256").update(artifact).digest("hex");
if (actual !== recorded) {
  console.error(`release-verify — SUMS MISMATCH (recorded ${recorded}, actual ${actual})`);
  process.exit(1);
}
console.log(`release-verify — sums match (${actual.slice(0, 20)}…)`);

// Rebuild from the same HEAD in a scratch dir; require byte-identical bytes.
const meta = JSON.parse(readFileSync(join(dist, "release-meta.json"), "utf8"));
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8", shell: false }).trim();
if (head !== meta.rev) {
  console.error(`release-verify — HEAD moved since prepare (${meta.rev} → ${head}); re-run release-prepare`);
  process.exit(1);
}
const scratch = mkdtempSync(join(tmpdir(), "aice-release-verify-"));
try {
  const tarOut = join(scratch, "rebuild.tar");
  execFileSync("git", ["archive", "--format=tar", "--output", tarOut, meta.rev], { cwd: ROOT, shell: false });
  const { createGzip } = await import("node:zlib");
  const gz = createGzip({ level: 9 });
  const chunks = [];
  gz.on("data", (c) => chunks.push(c));
  const promise = new Promise((resolvePromise) => gz.on("end", resolvePromise));
  gz.end(readFileSync(tarOut));
  await promise;
  const rebuilt = Buffer.concat(chunks);
  const rebuiltSha = createHash("sha256").update(rebuilt).digest("hex");
  if (rebuiltSha !== actual) {
    console.error(`release-verify — NOT REPRODUCIBLE: rebuild ${rebuiltSha.slice(0, 20)}… ≠ shipped ${actual.slice(0, 20)}…`);
    process.exit(1);
  }
  console.log("release-verify — reproducible: byte-identical rebuild from HEAD");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
console.log("release-verify — OK");
