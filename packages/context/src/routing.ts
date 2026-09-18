// Task classifier + deterministic router + debate/vote (P5.4, Plan §54.20–21).
// Hard rule: routing is a pure function of (task facts, registry). No randomness,
// no clock, no model-driven self-assignment — the same inputs ALWAYS pick the same
// model; every decision carries a human-auditable `rationale`.
import type { DataClassification, RiskLevel } from "../../core/src/index.ts";

export type TaskKind = "docs" | "code" | "security" | "ops";

export interface TaskFacts {
  readonly kind: TaskKind;
  readonly risk: RiskLevel;
  /** Verb analysis: task implies side effects (write/run/migrate/delete). */
  readonly mutating: boolean;
  /** Signals that justify a code-capable model (in-code reasoning). */
  readonly codeIntensive: boolean;
}

const KIND_SIGNALS: Readonly<Record<TaskKind, readonly RegExp[]>> = {
  code: [/\b(fix|bug|refactor|implement|feature|compile|type-?error|regression|patch)\b/i],
  security: [/\b(vuln|exploit|cve|secret|leak|xss|sqli|csfr|csrf|auth|tamper|inject|pentest|harden)\b/i],
  ops: [/\b(deploy|migrate|rollout|backup|restore|scale|release|infra|ci|pipeline)\b/i],
  docs: [/\b(document|readme|explain|describe|comment|guide|notes?)\b/i],
};

const HIGH_RISK = /\b(delete|drop|wipe|truncate|migrat(e|ion|ions)|prod(uction)?|data[-_ ]?loss|irreversible|force[- ]?push|rotate|credential|secret|auth|crypto|pay|charge)\b/i;
const MEDIUM_RISK = /\b(edit|write|modify|change|updat(e|ing)|patch|refactor|install|upgrade|downgrade|add)\b/i;

/** Pure keyword classifier; deterministic by construction. */
export function classifyTask(taskText: string): TaskFacts {
  let kind: TaskKind = "docs";
  let bestHits = 0;
  for (const k of ["code", "security", "ops", "docs"] as const) {
    const hits = KIND_SIGNALS[k].filter((re) => re.test(taskText)).length;
    if (hits > bestHits) {
      kind = k;
      bestHits = hits;
    }
  }
  const risk: RiskLevel = HIGH_RISK.test(taskText)
    ? "high"
    : MEDIUM_RISK.test(taskText)
      ? "medium"
      : "low";
  const mutating = MEDIUM_RISK.test(taskText) || HIGH_RISK.test(taskText);
  const codeIntensive = /\b(?:function|class)\b|\btests?\b|\bassert\b|`[^`]+`|\w+\.\w+\(/i.test(taskText) || kind === "code";
  return Object.freeze({ kind, risk, mutating, codeIntensive });
}

/** Subset of the storage ModelRow/ProviderRow the router reasons over (decoupled by contract). */
export interface RouteModel {
  readonly id: string;
  readonly providerId: string;
  readonly displayName: string;
  readonly verified: boolean;
  readonly contextWindow: number;
  readonly status: string;
  readonly costPerMtokOut: number | null;
}

export interface RouteProvider {
  readonly id: string;
  readonly protocol: string;
  readonly maxClassification: DataClassification;
  readonly enabled: boolean;
}

export interface RouteInput {
  readonly task: TaskFacts;
  readonly projectClassification: DataClassification;
  readonly models: readonly RouteModel[];
  readonly providers: readonly RouteProvider[];
}

export interface RouteDecision {
  readonly modelId: string;
  readonly providerId: string;
  readonly rule: string;
  readonly rationale: string;
  readonly candidates: readonly string[];
}

export const ROUTE_UNAVAILABLE = Symbol("route-unavailable");

const CLASS_RANK: Readonly<Record<DataClassification, number>> = {
  public: 0, internal: 1, confidential: 2, restricted: 3,
};

function providerCleared(p: RouteProvider, c: DataClassification): boolean {
  return CLASS_RANK[p.maxClassification] >= CLASS_RANK[c];
}

const CODE_LIKE_NAME = /(code|coder|deepseek|qwen|star|copilot|codestral|granite-c)/i;

/**
 * Rule table, evaluated top-down (first match wins; everyone inside a rule is
 * tie-broken deterministically on id):
 *   1. clearance  — only providers whose maxClassification covers the data
 *   2. restricted — additionally local-only (local-openai-compatible protocol)
 *   3. high risk  — strongest VERIFIED model (largest context window)
 *   4. code kind  — code-named verified model by descending context, then id
 *   5. docs kind  — cheapest adequate verified model (small names first)
 *   6. default    — verified, cheapest output cost, then lexicographic id
 */
export function routeTask(input: RouteInput): RouteDecision {
  const enabledProviders = new Map(
    input.providers.filter((p) => p.enabled).map((p) => [p.id, p] as const),
  );
  let pool = input.models.filter((m) => m.status === "active" || m.status === "available" || m.status === "known");
  pool = pool.filter((m) => {
    const p = enabledProviders.get(m.providerId);
    return p !== undefined && providerCleared(p, input.projectClassification);
  });
  if (input.projectClassification === "restricted") {
    pool = pool.filter((m) => enabledProviders.get(m.providerId)?.protocol === "local-openai-compatible");
  }
  const rationale: string[] = [];
  rationale.push(`clearance=${input.projectClassification} pool=${pool.map((m) => m.id).join(",") || "(empty)"}`);
  if (pool.length === 0) {
    return Object.freeze({
      modelId: "(none)",
      providerId: "(none)",
      rule: "unavailable",
      rationale: `${rationale.join("; ")} — no eligible model in registry`,
      candidates: Object.freeze([]),
    });
  }

  let rule: string;
  let chosen: RouteModel[];
  const verified = pool.filter((m) => m.verified);
  if (input.task.risk === "high") {
    rule = "high-risk→verified-max-context";
    const src = verified.length > 0 ? verified : pool;
    const maxCw = Math.max(...src.map((m) => m.contextWindow));
    chosen = src
      .filter((m) => m.contextWindow === maxCw)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  } else if (input.task.kind === "code" && verified.some((m) => CODE_LIKE_NAME.test(m.displayName))) {
    rule = "code→code-named-verified";
    chosen = verified
      .filter((m) => CODE_LIKE_NAME.test(m.displayName))
      .sort((a, b) => b.contextWindow - a.contextWindow || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  } else if (input.task.kind === "docs" && verified.length > 0) {
    rule = "docs→smallest-adequate";
    chosen = [...verified].sort(
      (a, b) =>
        a.contextWindow - b.contextWindow ||
        (a.costPerMtokOut ?? Number.POSITIVE_INFINITY) - (b.costPerMtokOut ?? Number.POSITIVE_INFINITY) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  } else {
    rule = "default→verified-cheapest";
    const src = verified.length > 0 ? verified : pool;
    chosen = [...src].sort(
      (a, b) =>
        (a.costPerMtokOut ?? Number.POSITIVE_INFINITY) - (b.costPerMtokOut ?? Number.POSITIVE_INFINITY) ||
        (a.verified === b.verified ? 0 : a.verified ? -1 : 1) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  }
  const pick = chosen[0] as RouteModel;
  const provName = enabledProviders.get(pick.providerId)?.protocol ?? "?";
  return Object.freeze({
    modelId: pick.id,
    providerId: pick.providerId,
    rule,
    rationale: `${rationale.join("; ")}; rule=${rule} (protocol=${provName})`,
    candidates: Object.freeze(chosen.map((m) => m.id)),
  });
}

/** Escalation: bumps risk one notch and re-routes (rules stay the truth). */
export function escalate(input: RouteInput): RouteInput {
  const bump: RiskLevel | undefined =
    input.task.risk === "low" ? "medium" : input.task.risk === "medium" ? "high" : undefined;
  if (bump === undefined) return input;
  return Object.freeze({ ...input, task: { ...input.task, risk: bump } });
}

// ---------------------------------------------------------------- debate / vote
export interface DebateCandidate {
  readonly model: string;
  readonly answer: string;
}

export interface DebateResult {
  readonly winner: string;
  readonly votes: Readonly<Record<string, number>>;
  readonly decidedBy: "fenced-verdict" | "keyword-consensus" | "tie→escalate";
  readonly tied: readonly string[];
}

const VERDICT_RE = /```verdict\s*\n([\s\S]*?)\n```/;
const CHOICE_KEYWORDS = ["approve", "reject", "yes", "no", "option-a", "option-b"] as const;

function choiceOf(answer: string): string | null {
  const m = VERDICT_RE.exec(answer);
  if (m !== null) {
    try {
      const parsed = JSON.parse(m[1] as string) as { choice?: unknown };
      if (typeof parsed.choice === "string" && parsed.choice !== "") return parsed.choice.toLowerCase();
    } catch {
      /* malformed fenced verdict falls through */
    }
  }
  const lower = answer.toLowerCase();
  const found = CHOICE_KEYWORDS.find((k) => lower.includes(k));
  return found ?? null;
}

/**
 * Majority vote over candidate answers; deterministic tie-break: with no strict
 * majority, the exchange ESCALATES (reported, never silently resolved).
 */
export function debateVote(candidates: readonly DebateCandidate[]): DebateResult {
  const votes = new Map<string, number>();
  let decidedBy: DebateResult["decidedBy"] = "fenced-verdict";
  for (const c of candidates) {
    const m = VERDICT_RE.exec(c.answer);
    const choice = choiceOf(c.answer);
    if (m === null) decidedBy = "keyword-consensus";
    if (choice === null) continue;
    votes.set(choice, (votes.get(choice) ?? 0) + 1);
    void choice;
  }
  const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  if (ranked.length === 0 || (ranked.length > 1 && ranked[0]![1] === ranked[1]![1])) {
    return Object.freeze({
      winner: "(escalate)",
      votes: Object.freeze(Object.fromEntries(votes)),
      decidedBy: "tie→escalate",
      tied: Object.freeze(ranked.slice(0, ranked.length > 1 && ranked[0]![1] === ranked[1]![1] ? 2 : 1).map((r) => r[0])),
    });
  }
  return Object.freeze({
    winner: ranked[0]![0],
    votes: Object.freeze(Object.fromEntries(votes)),
    decidedBy,
    tied: Object.freeze([]),
  });
}
