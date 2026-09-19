#!/usr/bin/env node
// release-prepare (P9.5): deterministic, operator-verifiable release artifact.
// Output: dist/aice-<version>-<shortrev>.tar.gz + SHA256SUMS.txt + release-meta.json.
// Invariants:
//   - built ONLY from git-tracked files at HEAD (never the dirty tree, never .local)
//   - working tree must be clean (tracked-diff refuses a misleading artifact)
//   - deterministic: gzip -n + fixed tar metadata → same HEAD → same bytes → same sha256
//   - meta is content-free (no timestamps) so reproduction is byte-exact
// Verification of full reproducibility lives in scripts/release-verify.mjs.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { createGzip } from "node:zlib";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(ROOT, "dist");

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", shell: false }).trim();
}

// tracked-diff check (untracked files are irrelevant — they never enter the archive)
const status = spawnSync("git", ["status", "--porcelain=v1", "-uno"], { cwd: ROOT, encoding: "utf8", shell: false });
if (status.status !== 0) {
  console.error("release-prepare — git status failed");
  process.exit(1);
}
if (status.stdout.trim() !== "") {
  console.error(`release-prepare — tracked working tree not clean; commit first:\n${status.stdout.trim().slice(0, 400)}`);
  process.exit(1);
}

const rev = git(["rev-parse", "HEAD"]);
const short = rev.slice(0, 12);
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const version = pkg.version;
const name = `aice-v${version}-${short}`;

mkdirSync(dist, { recursive: true });
// clean the artifact namespace so stale sums can't masquerade
for (const f of readdirSync(dist)) rmSync(join(dist, f), { recursive: true, force: true });

const tarPath = join(dist, `${name}.tar`);
const tgzPath = join(dist, `${name}.tar.gz`);

// `git archive` metadata is derived from the rev only (tree+commit-id + no mtime drift
// for identical input), and we neutralize gzip's timestamp (-n equivalent: mtime 0).
execFileSync("git", ["archive", "--format=tar", "--output", tarPath, rev], { cwd: ROOT, shell: false });
const raw = readFileSync(tarPath);
const gz = createGzip({ level: 9 });
gz.set_header = undefined; // node: no fname unless set; mtime defaults to 0-ms when not set
const chunks = [];
gz.on("data", (c) => chunks.push(c));
gz.on("end", () => {
  const tgz = Buffer.concat(chunks);
  writeFileSync(tgzPath, tgz);
  rmSync(tarPath);

  const sha = (b) => createHash("sha256").update(b).digest("hex");
  const meta = {
    name,
    version,
    rev,
    sourceOfTruth: "git archive HEAD (tracked files only)",
    gzipDeterminism: "mtime=0",
    files: { archive: `${name}.tar.gz`, sha256: sha(tgz) },
  };
  writeFileSync(join(dist, `SHA256SUMS.txt`), `${sha(tgz)}  ${name}.tar.gz\n`);
  writeFileSync(join(dist, `release-meta.json`), JSON.stringify(meta, null, 2) + "\n");
  console.log(`release-prepare — ${name}.tar.gz`);
  console.log(`release-prepare — sha256 ${sha(tgz)}`);
  console.log(`release-prepare — rev ${rev}`);
});
gz.end(raw);
