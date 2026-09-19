// Suspicious-instruction detection — Plan §16, threats T1/T2.
// ONE layer of defense: flags probable prompt-injection in untrusted content so the
// orchestrator can quarantine, confirm, or drop it. Never the sole control.

export interface InjectionFinding {
  readonly ruleId: string;
  readonly severity: "low" | "medium" | "high";
  readonly excerpt: string; // short redacted snippet for audit
}

interface Rule {
  readonly id: string;
  readonly severity: InjectionFinding["severity"];
  readonly re: RegExp;
}

const RULES: readonly Rule[] = Object.freeze([
  { id: "ignore-instructions", severity: "high", re: /ignor(e|ing)\s+(all\s+)?(previous|prior|above|earlier|system)\s+instructions?/i },
  { id: "override-safety", severity: "high", re: /(disregard|override|bypass|disable)\s+((all|any|the|prior|previous)\s+)?(safety|security|policy|policies|guardrails|restrictions)/i },
  { id: "jailbreak-persona", severity: "high", re: /\b(do\s+anything\s+now|developer\s+mode|jailbreak|unrestricted\s+mode|evil\s+assistant)\b/i },
  { id: "exfil-api-key", severity: "high", re: /(send|exfiltrat|leak|expose|output|print|reveal|return).{0,60}(api[_-]?key|secret|password|private[_-]?key|token)/i },
  { id: "system-prompt-steal", severity: "high", re: /(reveal|show|output|print|repeat).{0,40}(system\s+prompt|initial\s+instructions|hidden\s+instructions)/i },
  { id: "run-command", severity: "medium", re: /(run|execute)\s+(this\s+)?(command|script|code|payload)\s*[:-]/i },
  { id: "urgency-coercion", severity: "medium", re: /\b(urgent|immediately|asap|right\s+now|without\s+asking|do\s+not\s+ask|don't\s+ask)\b.{0,40}\b(send|delete|disable|run|execute|transfer)\b/i },
  { id: "instruction-in-data", severity: "low", re: /^\s*(note|important|attention|ps|p\.s\.|todo)\s*:\s*(you\s+must|always|never|make\s+sure)/im },
]);

// --- Unicode canonicalization lane (Phase 10) ---------------------------------------
// Attackers obfuscate payloads past plain regex rules with full-width letters,
// mathematical-alphabet glyphs, Cyrillic/Greek lookalikes, zero-width joiners and
// bidi controls. Detection therefore also runs over a canonical form. Canonicalization
// is strictly monotonic: it may add findings, never remove them.

/** Invisible-wordplay codepoints stripped before scanning (ZW*, bidi controls, soft hyphen). */
// D soft hyphen · 200B/200C ZWSP/ZWNJ · 200D ZWJ · 200E/200F LRM/RLM ·
// 202A-202E bidi embeddings/overrides · 2060-2064 word joiner family ·
// 2066-206F bidi isolates/deprecated · FEFF ZWNBSP. (Escaped codepoints only —
// never paste these literals into source.)
// eslint-disable-next-line no-misleading-character-class -- intentional: singleton control codepoints (including two ranges), not grapheme clusters.
const INVISIBLE_RE = /[\u00AD\u200B\u200C\u200D\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/gu;

/** Bounded confusables fold — conservative single-glyph lookalikes of ASCII letters. */
const CONFUSABLES: ReadonlyMap<string, string> = new Map([
  ["а", "a"], ["е", "e"], ["о", "o"], ["р", "p"], ["с", "c"], ["х", "x"],
  ["у", "y"], ["і", "i"], ["ј", "j"], ["ѕ", "s"], ["һ", "h"], ["ԁ", "d"], ["ѵ", "v"],
  ["ɡ", "g"], ["№", "N"],
  ["α", "a"], ["ε", "e"], ["ο", "o"], ["ρ", "p"], ["τ", "t"], ["υ", "u"],
  ["κ", "k"], ["ν", "v"], ["χ", "x"],
]);

function foldConfusables(s: string): string {
  let out = "";
  for (const ch of s) out += CONFUSABLES.get(ch) ?? ch;
  return out;
}

/**
 * Canonical form for detection: NFKC (folds full-width/math-alphabet glyphs) →
 * strip invisible/bidi controls → fold bounded confusables. Pure: ASCII/ordinary
 * text passes through unchanged.
 */
export function canonicalizeForDetection(text: string): string {
  return foldConfusables(text.normalize("NFKC").replace(INVISIBLE_RE, ""));
}

function excerptOf(text: string, index: number): string {
  const start = Math.max(0, index - 40);
  const raw = text.slice(start, index + 60).replace(/\s+/g, " ").trim();
  return raw.length > 100 ? `${raw.slice(0, 100)}…` : raw;
}

function scan(text: string): InjectionFinding[] {
  const findings: InjectionFinding[] = [];
  for (const rule of RULES) {
    const m = rule.re.exec(text);
    if (m?.index !== undefined) {
      findings.push({ ruleId: rule.id, severity: rule.severity, excerpt: excerptOf(text, m.index) });
    }
  }
  return findings;
}

/**
 * Scan untrusted content. Empty array = nothing flagged (not proof of safety).
 * Runs the rules over the raw text AND its canonical form; canonical-only hits
 * carry the hit rule id (the finding record already notes the obfuscation by its
 * distinct ruleId — canonical hits are strictly additional).
 */
export function detectSuspiciousInstructions(text: string): readonly InjectionFinding[] {
  const findings: InjectionFinding[] = scan(text);
  const canonical = canonicalizeForDetection(text);
  if (canonical !== text) {
    const rawIds = new Set(findings.map((f) => f.ruleId));
    for (const f of scan(canonical)) {
      // Canonical-only novel hits are the obfuscation-evasion signal; also always
      // record the hygiene class that made canonicalization alter the string.
      if (!rawIds.has(f.ruleId)) findings.push(f);
    }
    findings.push({
      ruleId: "unicode-obfuscation",
      severity: "medium",
      excerpt: `canonicalization altered the string (${text.length} → ${canonical.length} code units)`,
    });
  }
  return Object.freeze(findings);
}

/** Highest severity present, or null when clean. */
export function maxSeverity(
  findings: readonly InjectionFinding[],
): InjectionFinding["severity"] | null {
  const rank = { low: 0, medium: 1, high: 2 } as const;
  let best: InjectionFinding["severity"] | null = null;
  for (const f of findings) {
    if (best === null || rank[f.severity] > rank[best]) best = f.severity;
  }
  return best;
}
