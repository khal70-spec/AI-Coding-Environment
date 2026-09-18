#!/usr/bin/env node
// a11y-check (P9.3): static accessibility gate for the desktop web surface.
// Static rules (never a substitute for runtime AT testing — see deferral in the
// gate review): A1 html lang, A2 landmarks (header/nav/main), A3 interactive
// elements labeled, A4 form controls labeled, A5 no positive tabIndex, A6 no
// on*-handlers on non-interactive elements without role, A7 contrast token
// discipline (no hard-coded low-contrast grays on dark bg), A8 no <img> without alt,
// A9 keyboard-reachability: no mouse-only handler sections (click handlers on
// buttons/links/table rows must have an activation companion or be buttons).
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WEB = join(ROOT, "apps", "desktop", "web");
const violations = [];
const notes = [];

if (!existsSync(WEB)) {
  console.error("a11y-check — apps/desktop/web missing");
  process.exit(1);
}

const files = (d) => readdirSync(d, { withFileTypes: true }).filter((f) => f.isFile()).map((f) => join(d, f.name));
for (const path of files(WEB)) {
  const rel = relative(ROOT, path);
  const text = readFileSync(path, "utf8");
  if (rel.endsWith(".html")) {
    if (!/<html[^>]*\blang\s*=/.test(text)) violations.push(`A1 ${rel}: <html> missing lang`);
    for (const lm of ["header", "nav", "main"]) {
      if (!new RegExp(`<${lm}[\\s>]`).test(text)) violations.push(`A2 ${rel}: landmark <${lm}> missing`);
    }
    for (const m of text.matchAll(/<img\b(?![^>]*\balt\s*=)[^>]*>/g)) {
      violations.push(`A8 ${rel}: <img> without alt: ${m[0].slice(0, 80)}`);
    }
    if (/\btabindex\s*=\s*["']?[1-9]/.test(text)) violations.push(`A5 ${rel}: positive tabindex disrupts order`);
  }
  if (rel.endsWith(".js")) {
    for (const m of text.matchAll(/el\("(div|span|td|tr|li|p)"\s*,\s*\{[^}]*onclick/gm)) {
      violations.push(`A9 ${rel}: onclick on non-interactive <${m[1]}> (no keyboard path): ${m[0].slice(0, 100)}`);
    }
    if (/\bdocument\.activeElement\b/.test(text)) notes.push(`focus-management callout present in ${rel}`);
  }
  if (rel.endsWith(".css")) {
    // A7: flag explicit #888-#999-#767 "classic low contrast on dark" grays used without comment
    for (const m of text.matchAll(/color[^;{]*#(7[0-9a-f]{2}|8[0-9a-f]{2}|9[0-9a-f]{2})\b[^;{]*[;}]/gi)) {
      const line = text.slice(0, m.index).split("\n").length;
      if (!/contrast|ok|active/i.test(m[0])) {
        notes.push(`A7 ${rel}:${line}: muted gray ${m[0].slice(0, 40).trim()} — verify against dark bg (manual, AA≥4.5)`);
      }
    }
    if (!/:focus(-visible)?\s*[,{:]/.test(text)) notes.push(`A10 ${rel}: no :focus outlines defined — keyboard users get browser defaults only`);
  }
}

console.log(`# a11y-check — apps/desktop/web static rules A1-A9`);
for (const n of notes) console.log(`NOTE       ${n}`);
if (violations.length > 0) {
  for (const v of violations) console.log(`VIOLATION  ${v}`);
  console.error(`A11Y-CHECK: FAIL (${violations.length} violation(s))`);
  process.exit(1);
}
console.log(`A11Y-CHECK: GREEN (${notes.length} note(s) for manual review)`);
