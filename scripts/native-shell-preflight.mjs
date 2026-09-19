#!/usr/bin/env node
// Native-shell preflight — executable readiness probe for the Tauri desktop trunk
// (the single remaining master-plan domain). Read-only, zero-dep, offline-safe:
// each check is local except the rustup reachability probe, which itself is the
// blocker datapoint we already recorded. Usage:
//   node scripts/native-shell-preflight.mjs            # human/CI report, exit 0
//   node scripts/native-shell-preflight.mjs --require-ready  # exit 1 when blocked
//
// The TRUNK is genuinely blocked in this sandbox today; the script's purpose is
// to make "blocked" measurable, diff-able and CI-visible instead of anecdotal.
import { spawnSync, execSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "../..");
const strict = process.argv.includes("--require-ready");

function which(bin) {
  const r = spawnSync("sh", ["-c", `command -v ${bin} || true`], { encoding: "utf8", timeout: 10_000 });
  return r.stdout.trim() !== "" ? r.stdout.trim() : null;
}
function commandOk(argv, timeout) {
  try {
    execSync(argv.join(" "), { stdio: "pipe", timeout });
    return true;
  } catch { return false; }
}
function httpCode(url, timeoutMs) {
  const r = spawnSync("curl", ["-sI", url, "-o", "/dev/null", "-w", "%{http_code}", "--max-time", String(Math.ceil(timeoutMs / 1000))], { encoding: "utf8", timeout: timeoutMs + 4000 });
  return r.status === 0 ? r.stdout.trim() : "000";
}

const checks = [
  { name: "rustc", found: which("rustc") !== null, lane: "core toolchain" },
  { name: "cargo", found: which("cargo") !== null, lane: "core toolchain" },
  { name: "pkg-config", found: which("pkg-config") !== null, lane: "system deps discovery" },
  { name: "webkit2gtk-4.1", found: which("pkg-config") !== null && commandOk(["pkg-config", "--exists", "webkit2gtk-4.1"], 10_000), lane: "Tauri webview runtime" },
  { name: "rustup-install-host", found: /^(2|3)\d\d$/.test(httpCode("https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu/rustup-init", 8_000)), lane: "toolchain bootstrap reachability" },
];

const blocked = checks.filter((c) => !c.found);
const ready = blocked.length === 0;
const report = {
  checkedAt: new Date().toISOString(),
  ready,
  checks: checks.map((c) => ({ name: c.name, ok: c.found, lane: c.lane })),
};
mkdirSync(join(root, "dist"), { recursive: true });
writeFileSync(join(root, "dist/native-shell-preflight.json"), JSON.stringify(report, null, 2) + "\n");

for (const c of checks) {
  console.log(`${c.found ? "✓" : "✗"} ${c.name.padEnd(20)} ${c.lane}`);
}
console.log(`NATIVE-SHELL-PREFLIGHT: ${ready ? "READY" : `BLOCKED (${blocked.length} checks) — see docs/development/native-shell-execution-plan.md`}`);
if (strict && !ready) process.exit(1);
