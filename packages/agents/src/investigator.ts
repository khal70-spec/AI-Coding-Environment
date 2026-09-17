// Investigator — Plan §4/§15 (P4.2). Read-only exploration agent: walks the task
// jail with fs.read/fs.list/fs.search/git.exec and returns an INVESTIGATION NOTE.
// The manifest stays fsWrite=none — artifacts return to the orchestrator as text;
// persistent storage is the orchestrator's job, never the model's.
import type { PolicyContext } from "../../policy/src/index.ts";
import type { ToolRunner } from "../../tools/src/index.ts";
import { AgentRunner, type AgentRunOptions, type AgentRunResult, type AgentTransport } from "./runtime.ts";
import { BUILTIN_MANIFESTS } from "./index.ts";

export interface InvestigateTaskSpec {
  readonly title: string;
  readonly risk?: string;
  /** Optional hint paths/terms that ground the walk. */
  readonly hints?: readonly string[];
}

export interface InvestigateResult {
  readonly status: AgentRunResult["status"];
  /** Investigation note = final assistant text (null on non-completed statuses). */
  readonly note: string | null;
  readonly rounds: number;
  readonly toolCalls: number;
  readonly denials: number;
  readonly pendingApproval: AgentRunResult["pendingApproval"];
  readonly transcript: AgentRunResult["transcript"];
}

export const INVESTIGATION_SECTIONS_GUIDE = [
  "## Summary",
  "## Relevant code (file:line)",
  "## Dependencies & entry points",
  "## Risks / security notes",
  "## Suggested verification (tests/scans)",
] as const;

export function investigate(
  deps: {
    readonly runner: ToolRunner;
    readonly jailRoot: string;
    readonly policyCtx: PolicyContext;
    readonly transport: AgentTransport;
    readonly task: InvestigateTaskSpec;
  },
  opts: AgentRunOptions = {},
): Promise<InvestigateResult> {
  const agent = new AgentRunner({
    runner: deps.runner,
    manifest: BUILTIN_MANIFESTS.investigator,
    jailRoot: deps.jailRoot,
    policyCtx: deps.policyCtx,
    transport: deps.transport,
  });
  const hints =
    deps.task.hints !== undefined && deps.task.hints.length > 0
      ? `\nGrounding hints: ${deps.task.hints.join(", ")}.`
      : "";
  const userPrompt = [
    `TASK (investigate, read-only): ${deps.task.title}${deps.task.risk ? ` (risk: ${deps.task.risk})` : ""}${hints}`,
    "",
    "Explore the workspace minimally but accurately: list, read the files that matter,",
    "search where ambiguity remains. You MUST NOT modify anything (and cannot — your",
    "grant is read-only).",
    "",
    "Finish with an INVESTIGATION NOTE containing exactly these sections:",
    ...INVESTIGATION_SECTIONS_GUIDE,
  ].join("\n");
  return agent.run(userPrompt, opts).then((res) => ({
    status: res.status,
    note: res.finalText,
    rounds: res.rounds,
    toolCalls: res.toolCalls,
    denials: res.denials,
    pendingApproval: res.pendingApproval,
    transcript: res.transcript,
  }));
}
