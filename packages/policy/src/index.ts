// @ai-coding-env/policy — Plan §8, §18. Pure evaluation kernel.
// Every tool call: manifest + task risk + workspace policy + global policy
//   → allow | approval | deny. Deny-by-default. No I/O, no deps.
import type { DataClassification, RiskLevel } from "../../core/src/index.ts";
import { classificationAllowed, riskAtLeast } from "../../core/src/index.ts";

export type Decision = "allow" | "approval" | "deny";

export type FsScope = "none" | "workspace" | "project";
export type TerminalGrant = "none" | "approved_commands" | "full";

export interface ToolRequest {
  readonly tool: string;
  readonly risk: RiskLevel;
  /** Data the tool will read/send. */
  readonly classification: DataClassification;
  /** True when the call matches a Plan §9 dangerous-operation shape. */
  readonly dangerous: boolean;
  /** True when the shape can never be approved (e.g. exfiltration). */
  readonly neverAllow: boolean;
  /** Filesystem scope the call needs (for fs tools). */
  readonly fsScope?: FsScope;
  /** Network host the call needs (for network tools). */
  readonly networkHost?: string;
}

export interface AgentGrant {
  readonly toolsAllow: readonly string[];
  readonly toolsDeny: readonly string[];
  readonly fsRead: FsScope;
  readonly fsWrite: FsScope;
  readonly terminal: TerminalGrant;
  readonly networkDefault: "deny" | "allow";
  readonly networkAllow: readonly string[];
  readonly maxRisk: RiskLevel;
  /** Highest classification this agent may send to its assigned provider. */
  readonly maxClassification: DataClassification;
}

export interface PolicyContext {
  /** Workspace-level kill switch / lock. */
  readonly workspaceLocked: boolean;
  /** Provider clearance for the data path (classification-aware routing). */
  readonly providerMaxClassification: DataClassification;
}

export interface PolicyVerdict {
  readonly decision: Decision;
  readonly reasons: readonly string[];
}

const SCOPE_ORDER: Readonly<Record<FsScope, number>> = Object.freeze({
  none: 0,
  workspace: 1,
  project: 2,
});

function scopeCovers(granted: FsScope, needed: FsScope): boolean {
  return SCOPE_ORDER[granted] >= SCOPE_ORDER[needed];
}

export function evaluate(request: ToolRequest, grant: AgentGrant, ctx: PolicyContext): PolicyVerdict {
  const reasons: string[] = [];

  if (ctx.workspaceLocked) {
    return { decision: "deny", reasons: ["workspace locked"] };
  }
  if (request.neverAllow) {
    return { decision: "deny", reasons: ["operation class is never allowed"] };
  }
  if (grant.toolsDeny.includes(request.tool) || grant.toolsDeny.includes("*")) {
    return { decision: "deny", reasons: [`tool denied for agent: ${request.tool}`] };
  }
  if (!grant.toolsAllow.includes(request.tool) && !grant.toolsAllow.includes("*")) {
    return { decision: "deny", reasons: [`tool not granted to agent: ${request.tool}`] };
  }
  if (!classificationAllowed(request.classification, grant.maxClassification)) {
    return {
      decision: "deny",
      reasons: [`classification ${request.classification} exceeds agent clearance ${grant.maxClassification}`],
    };
  }
  if (!classificationAllowed(request.classification, ctx.providerMaxClassification)) {
    return {
      decision: "deny",
      reasons: [
        `classification ${request.classification} exceeds provider clearance ${ctx.providerMaxClassification}`,
      ],
    };
  }
  if (request.fsScope !== undefined && !scopeCovers(grant.fsWrite, request.fsScope)) {
    // Read-vs-write unknown here; callers pass the needed scope and the engine
    // conservatively checks against write grant for mutating tools. Read-only tools
    // should pass fsScope "none" unless they escape the workspace.
    reasons.push(`filesystem scope ${request.fsScope} exceeds grant ${grant.fsWrite}`);
    return { decision: "deny", reasons };
  }
  if (request.networkHost !== undefined) {
    if (grant.networkDefault === "deny" && !grant.networkAllow.includes(request.networkHost)) {
      return { decision: "deny", reasons: [`network host not granted: ${request.networkHost}`] };
    }
  }

  // Risk gates (Plan §33): high-risk always needs a human; dangerous ops too.
  if (request.dangerous) {
    reasons.push("dangerous operation — explicit approval required");
    return { decision: "approval", reasons };
  }
  if (request.risk === "high") {
    reasons.push("high-risk action — explicit approval required");
    return { decision: "approval", reasons };
  }
  if (riskAtLeast(request.risk, "medium") && grant.maxRisk === "low") {
    reasons.push(`risk ${request.risk} exceeds agent max ${grant.maxRisk}`);
    return { decision: "approval", reasons };
  }
  if (request.risk === "medium" && grant.terminal === "none" && request.tool.startsWith("terminal.")) {
    reasons.push("terminal not granted");
    return { decision: "deny", reasons };
  }
  return { decision: "allow", reasons: ["within grant"] };
}
