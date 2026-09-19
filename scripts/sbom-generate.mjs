#!/usr/bin/env node
// SBOM generator — Phase 10 lane of dependency-policy v2. Emits a CycloneDX 1.5
// document for the workspace, deterministic (no timestamps in the hash-relevant
// payload; components sorted). Offline by construction: needs the vendored
// package-lock.json + workspace manifests, nothing else.
//
// Usage: node scripts/sbom-generate.mjs [--out dist/sbom.cyclonedx.json]
//        --print   stdout instead of file write
// Exit: 0 on success; 1 on malformed manifests (fail closed).
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "../..");
const arg = {};
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i];
  if (!a.startsWith("--")) continue;
  const next = process.argv[i + 1];
  if (next !== undefined && !next.startsWith("--")) { arg[a.slice(2)] = next; i += 1; }
  else { arg[a.slice(2)] = true; }
}

function loadJson(path, label) {
  try {
    return JSON.parse(readFileSync(join(root, path), "utf8"));
  } catch (e) {
    console.error(`SBOM: FAILED — cannot read ${label} (${path}): ${e.message}`);
    process.exit(1);
  }
}

const rootPkg = loadJson("package.json", "root manifest");

function assertUnique(list, pkg) {
  if (list.some((c) => c.name === pkg.name)) {
    console.error(`SBOM: FAILED — duplicate workspace package name: ${pkg.name}`);
    process.exit(1);
  }
}
const lock = loadJson("package-lock.json", "lockfile");
if (lock.lockfileVersion !== 3) {
  console.error(`SBOM: FAILED — lockfile v3 required, got ${lock.lockfileVersion}`);
  process.exit(1);
}

// workspace manifests (root workspaces globs are simple dir patterns here)
const components = [];
const workspaceManifests = [];
for (const ws of rootPkg.workspaces ?? []) {
  const dir = ws.replace("/*", "");
  for (const name of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    const manifest = join(dir, name.name, "package.json");
    if (!existsSync(join(root, manifest))) continue; // app dirs without a manifest are not npm workspaces
    const pkg = loadJson(manifest, `workspace manifest ${manifest}`);
    assertUnique(components, pkg);
    workspaceManifests.push({ dir: manifest, pkg });
  }
}

// 1) workspace packages themselves (type: application/library, purl stable form)
for (const { dir, pkg } of workspaceManifests.sort((a, b) => a.dir.localeCompare(b.dir))) {
  components.push({
    "type": "library",
    "bom-ref": `pkg:npm/${pkg.name}@${pkg.version ?? "0.0.0"}`,
    "name": pkg.name,
    "version": pkg.version ?? "0.0.0",
    "purl": `pkg:npm/${pkg.name}@${pkg.version ?? "0.0.0"}`,
    "properties": [{ "name": "workspace:path", "value": relative(root, join(root, dir)).split("\\").join("/") }],
    "licenses": [{ "license": { "id": pkg.license ?? rootPkg.license ?? "NOASSERTION" } }],
  });
}

// 2) third-party deps from the lockfile — only what is ACTUALLY locked, with the
//    integrity hash carried through. Scope notes the dev/runtime lane.
const lockPaths = Object.keys(lock.packages ?? {}).filter((k) => k.startsWith("node_modules/") && !k.startsWith("node_modules/@ai-coding-env/") && !k.startsWith("node_modules/%40ai-coding-env/"));
for (const lockPath of lockPaths.sort()) {
  const entry = lock.packages[lockPath];
  const name = lockPath.slice("node_modules/".length);
  components.push({
    "type": "library",
    "bom-ref": `pkg:npm/${name}@${entry.version}`,
    "name": name,
    "version": entry.version,
    "purl": `pkg:npm/${name}@${entry.version}`,
    ...(typeof entry.integrity === "string"
      ? { "hashes": [{ "alg": "SHA-512", "content": entry.integrity.replace(/^sha512-/, "") }] }
      : {}),
    "properties": [{ "name": "cdx:npm:development", "value": String(entry.dev === true) }],
    ...(Array.isArray(entry.license) && entry.license.length > 0
      ? { "licenses": [{ "license": { "id": entry.license[0] } }] }
      : typeof entry.license === "string"
        ? { "licenses": [{ "license": { "id": entry.license } }] }
        : {}),
  });
}

const bom = {
  "$schema": "http://cyclonedx.org/schema/bom-1.5.schema.json",
  "bomFormat": "CycloneDX",
  "specVersion": "1.5",
  "serialNumber": `urn:uuid:${rootPkg.name}-${rootPkg.version}-deterministic`, // deterministic by design
  "version": 1,
  "metadata": {
    "component": {
      "type": "application",
      "bom-ref": `pkg:npm/${rootPkg.name}@${rootPkg.version}`,
      "name": rootPkg.name,
      "version": rootPkg.version,
      "description": rootPkg.description,
      "licenses": [{ "license": { "id": rootPkg.license } }],
    },
    "tools": [{ "vendor": "aice", "name": "scripts/sbom-generate.mjs", "version": "1.0.0" }],
    "properties": [{ "name": "sbom:generated-at-policy", "value": "deterministic: timestamp omitted (reproducible artifacts)" }],
  },
  components,
};

const out = JSON.stringify(bom, null, 2) + "\n";
const runtimeCount = lockPaths.filter((k) => lock.packages[k].dev !== true).length;
if (arg.print === true) process.stdout.write(out);
else {
  const target = resolve(root, typeof arg.out === "string" ? arg.out : "dist/sbom.cyclonedx.json");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, out);
  console.log(`SBOM: wrote ${components.length} components → ${relative(root, target)}`);
}
console.error(`SBOM: ${components.length} components (${workspaceManifests.length} workspace, ${lockPaths.length} locked, ${runtimeCount} runtime-lane)`);
