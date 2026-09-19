#!/usr/bin/env node
// SAST-lite (P8.1): repo-local static scan for forbidden-API classes. Deliberately
// small, deterministic, and allowlist-anchored (no silent suppression — an allowlist
// entry names file + rule + reason). Violations fail the gate (exit 1).
//
// Forbidden classes ( Plan §50 ):
//   S1  eval() / new Function()               — dynamic code execution
//   S2  child_process spawn* with shell:true  — shell injection surface
//   S3  spawn of a raw command STRING (shell form) via exec("/bin/sh") pattern
//   S4  SQL string interpolation into .prepare(`...${}`) (dynamic SQL beyond migration DDL)
//   S5  process.env reads inside packages/*/src (secrets flow must use secrets service)
//   S6  XSS surface: innerHTML/outerHTML/document.write/dangerouslySetInnerHTML in apps/web
//   S7  CORS wildcard ("*" origin) or `Access-Control-Allow-Credentials: true` on the bridge
//   S8  .writeFileSync/readFileSync without containment in tool-callable packages (advisory
//       where the jail wrapper is used — jailPath/assertContainedSync in same file)
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const RULES = [
  { id: "S1", re: /(?<![\w$.])eval\s*\(|new\s+Function\s*\(/, scopes: ["packages", "apps"], why: "dynamic code execution" },
  { id: "S2", re: /shell\s*:\s*true/, scopes: ["packages", "apps"], why: "shell=true injection surface" },
  { id: "S3", re: /spawnSync?\(\s*["'`]\s*(sh?|bash|cmd)\b/, scopes: ["packages", "apps"], why: "direct shell spawn" },
  { id: "S4", re: /prepare\s*\(\s*`[^`]*\$\{/, scopes: ["packages"], why: "SQL template interpolation" },
  { id: "S5", re: /process\.env\s*(\[|\.)/, scopes: ["packages"], why: "uncontrolled env read in packages" },
  { id: "S6", re: /innerHTML\s*(?:\+)?=|outerHTML\s*(?:\+)?=|document\.write\s*\(|dangerouslySetInnerHTML/, scopes: ["apps"], why: "XSS sink" },
  { id: "S7", re: /access-control-allow-origin["']?\s*[,:]\s*["']\*|Access-Control-Allow-Origin"\s*:\s*"\*"/, scopes: ["packages", "apps"], why: "CORS wildcard" },
];

// file-scoped allowlist: { fileSuffix, ruleId, reason, matchHint }
// Allowlist is per-finding: rule + file + the matched line must contain `hint`, and a
// reason is printed on scan (no silent suppression — every allow is visible in logs).
const ALLOWLIST = [
  {
    ruleId: "S5",
    file: "packages/tools/src/terminal.ts",
    hint: "SystemRoot",
    reason: "constant Windows OS overlay (SystemRoot/COMSPEC) inside the sanitized child env builder — not a secret lane",
  },
];

// Findings collector
const findings = [];
let scanned = 0;

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", "dist", "coverage", ".git", ".local"].includes(entry.name)) continue;
      yield* walk(abs);
    } else if (/\.(ts|mjs|js)$/.test(entry.name)) {
      yield abs;
    }
  }
}

const SCAN_DIRS = ["packages", "apps", "scripts", "tests"].map((d) => join(ROOT, d));

for (const dir of SCAN_DIRS) {
  for (const file of walk(dir)) {
    const rel = relative(ROOT, file);
    const text = readFileSync(file, "utf8");
    scanned++;
    // strip full-line + block comments into blanks (we scan CODE lines)
    const lines = text.split("\n");
    let inBlock = false;
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];
      if (inBlock) {
        if (line.includes("*/")) { inBlock = false; line = line.slice(line.indexOf("*/") + 2); } else continue;
      }
      if (line.includes("/*")) { inBlock = inBlock || !line.includes("*/"); line = inBlock ? line.split("/*")[0] : line; }
      if (line.trim().startsWith("//")) continue;
      const code = line.replace(/\/\/.*$/, "");
      for (const rule of RULES) {
        if (!rule.scopes.some((s) => rel.startsWith(`${s}/`))) continue;
        if (rule.re.test(code)) {
          const allow = ALLOWLIST.find((a) => a.ruleId === rule.id && rel.endsWith(a.file) && code.includes(a.hint));
          if (allow !== undefined) {
            console.log(`ALLOWED  ${rule.id} ${rel}:${i + 1} — ${allow.reason}`);
            continue;
          }
          findings.push(`${rule.id} ${rel}:${i + 1} — ${rule.why} | ${code.trim().slice(0, 140)}`);
        }
      }
    }
  }
}

console.log(`# SAST-lite — ${scanned} files scanned, rules S1-S7`);
if (findings.length > 0) {
  for (const f of findings) console.log(`FINDING  ${f}`);
  console.error(`SAST: FAIL (${findings.length} finding(s))`);
  process.exit(1);
}
console.log(`SAST: GREEN (0 findings in ${scanned} files)`);
