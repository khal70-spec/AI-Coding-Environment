// Architect/planner — Plan §4/§16 (P4.3). Turns a task + investigation note into a
// concrete, stepwise PLAN. May write the plan artifact into the task workspace
// (manifest grant fsWrite=workspace; overwrite stays approval-gated via the kernel).
import type { PolicyContext } from "../../policy/src/index.ts";
import type { ToolRunner } from "../../tools/src/index.ts";
import { AgentRunner, type AgentRunOptions, type AgentRunResult, type AgentTransport } from "./runtime.ts";
import { BUILTIN_MANIFESTS } from "./index.ts";

export interface ArchitectTaskSpec {
  readonly title: string;
  readonly risk?: string;
  /** Investigation note text from the investigator phase (may be plain text). */
  readonly investigation: string;
}

export interface PlanResult {
  readonly status: AgentRunResult["status"];
  /** Plan document = final assistant text (null on non-completed statuses). */
  readonly plan: string | null;
  readonly rounds: number;
  readonly toolCalls: number;
  readonly denials: number;
  readonly pendingApproval: AgentRunResult["pendingApproval"];
  readonly transcript: AgentRunResult["transcript"];
}

export const PLAN_SECTIONS_GUIDE = [
  "## Goal",
  "## Steps (numbered; each lists files + verification)",
  "## Risk notes & rollback",
  "## Definition of done",
] as const;

/** Lightweight structure check: a "## Steps" section with ≥1 numbered bullet. */
export function planLooksStructured(text: string): boolean {
  const steps = text.split("\n").filter((l) => /^\s*\d+[.)]\s+\S/.test(l)).length;
  return /##\s*steps/i.test(text) && steps >= 1;
}

export function architectPlan(
  deps: {
    readonly runner: ToolRunner;
    readonly jailRoot: string;
    readonly policyCtx: PolicyContext;
    readonly transport: AgentTransport;
    readonly task: ArchitectTaskSpec;
    readonly approved?: boolean;
  },
  opts: AgentRunOptions = {},
): Promise<PlanResult> {
  const agent = new AgentRunner({
    runner: deps.runner,
    manifest: BUILTIN_MANIFESTS.architect,
    jailRoot: deps.jailRoot,
    policyCtx: deps.policyCtx,
    transport: deps.transport,
    ...(deps.approved === true ? { approved: true } : {}),
  });
  const userPrompt = [
    `TASK (plan): ${deps.task.title}${deps.task.risk ? ` (risk: ${deps.task.risk})` : ""}`,
    "",
    "INVESTIGATION NOTE (input):",
    "<<<INVESTIGATION (untrusted context)>>>",
    deps.task.investigation,
    "<<<END-INVESTIGATION>>>",
    "",
    "Produce a concrete implementation plan. You may persist it as PLAN.md in the",
    "workspace (new file; overwrites require human approval). Architecture decisions",
    "and risky steps MUST be called out explicitly.",
    "",
    "Finish with the PLAN containing exactly these sections:",
    ...PLAN_SECTIONS_GUIDE,
  ].join("\n");
  return agent.run(userPrompt, opts).then((res) => ({
    status: res.status,
    plan: res.finalText,
    rounds: res.rounds,
    toolCalls: res.toolCalls,
    denials: res.denials,
    pendingApproval: res.pendingApproval,
    transcript: res.transcript,
  }));
}
