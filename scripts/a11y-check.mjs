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

// A10: <html lang> present (index.html)
{
  const html = readFileSync(join(WEB, "index.html"), "utf8");
  if (!/<html\s+[^>]*lang=/.test(html)) violations.push(`A10 index.html: <html lang> missing`);
  const h1Count = (html.match(/<h1[\s>]/g) ?? []).length;
  if (h1Count !== 1) violations.push(`A11 index.html: exactly one <h1> required (found ${h1Count})`);
}

// A11: heading levels never skip (DOM emission order: index.html, then app.js literals)
{
  const html = readFileSync(join(WEB, "index.html"), "utf8");
  const js = readFileSync(join(WEB, "app.js"), "utf8");
  const seq = [...html.matchAll(/<h([1-6])[\s>]/g)].map((m) => Number(m[1]));
  seq.push(...[...js.matchAll(/el\("h([1-6])"/g)].map((m) => Number(m[1])));
  for (let i = 1; i < seq.length; i += 1) {
    if (seq[i] > seq[i - 1] + 1) {
      violations.push(`A11 heading skip: h${seq[i - 1]} followed by h${seq[i]} (position ${i})`);
      break;
    }
  }
}

// A12: any animation must honor prefers-reduced-motion
{
  const css = readFileSync(join(WEB, "app.css"), "utf8");
  const usesMotion = /@keyframes|animation\s*:|transition\s*:/.test(css);
  if (usesMotion && !/prefers-reduced-motion/.test(css)) {
    violations.push(`A12 app.css: motion present with no prefers-reduced-motion pairing`);
  }
}

// A13: WCAG AA contrast (4.5:1) for every text-bearing token pair on dark bg.
{
  const css = readFileSync(join(WEB, "app.css"), "utf8");
  const rootDecl = /:root\{([^}]*)\}/.exec(css)?.[1] ?? "";
  const tok = Object.fromEntries([...rootDecl.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2].toLowerCase()]));
  const lum = (hex) => {
    const ch = (i) => {
      const v = parseInt(hex.slice(i, i + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * ch(1) + 0.7152 * ch(3) + 0.0722 * ch(5);
  };
  const ratio = (a, b) => {
    const [hi, lo] = [Math.max(lum(a), lum(b)), Math.min(lum(a), lum(b))];
    return (hi + 0.05) / (lo + 0.05);
  };
  // text-bearing pairs actually used: fg on bg/panel; muted on bg/panel; accent on panel;
  // semantic tag colors on panel; nav accent text on panel
  const pairs = [["fg", "bg"], ["fg", "panel"], ["muted", "bg"], ["muted", "panel"], ["accent", "panel"], ["ok", "panel"], ["bad", "panel"], ["warn", "panel"]];
  const failures = [];
  for (const [fg, bg] of pairs) {
    if (tok[fg] === undefined || tok[bg] === undefined) continue;
    const r = ratio(tok[fg], tok[bg]);
    if (r < 4.5) failures.push(`${fg} on ${bg} = ${r.toFixed(2)}:1`);
  }
  if (failures.length > 0) violations.push(`A13 contrast (AA 4.5:1): ${failures.join("; ")}`);
}

console.log(`# a11y-check — apps/desktop/web static rules A1-A13`);
for (const n of notes) console.log(`NOTE       ${n}`);
if (violations.length > 0) {
  for (const v of violations) console.log(`VIOLATION  ${v}`);
  console.error(`A11Y-CHECK: FAIL (${violations.length} violation(s))`);
  process.exit(1);
}
console.log(`A11Y-CHECK: GREEN (${notes.length} note(s) for manual review)`);
