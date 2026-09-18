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

function excerptOf(text: string, index: number): string {
  const start = Math.max(0, index - 40);
  const raw = text.slice(start, index + 60).replace(/\s+/g, " ").trim();
  return raw.length > 100 ? `${raw.slice(0, 100)}…` : raw;
}

/** Scan untrusted content. Empty array = nothing flagged (not proof of safety). */
export function detectSuspiciousInstructions(text: string): readonly InjectionFinding[] {
  const findings: InjectionFinding[] = [];
  for (const rule of RULES) {
    const m = rule.re.exec(text);
    if (m?.index !== undefined) {
      findings.push({ ruleId: rule.id, severity: rule.severity, excerpt: excerptOf(text, m.index) });
    }
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
