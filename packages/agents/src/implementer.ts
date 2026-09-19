// Implementer — Plan §4/§17 (P4.4). Executes an approved plan inside the task jail:
// edits via fs.write/fs.edit (approval flow intact), verifies with test.exec, and
// feeds failures back into bounded fix iterations (MAX_FIX_ATTEMPTS from the
// orchestrator engine is cited in the prompt; the loop kernel caps rounds too).
import type { PolicyContext } from "../../policy/src/index.ts";
import type { ToolRunner } from "../../tools/src/index.ts";
import { AgentRunner, type AgentRunOptions, type AgentRunResult, type AgentTransport } from "./runtime.ts";
import { BUILTIN_MANIFESTS } from "./index.ts";

export const MAX_IMPLEMENT_FIX_ATTEMPTS = 3;

export interface ImplementerTaskSpec {
  readonly title: string;
  readonly plan: string;
}

export interface TestVerdict {
  readonly round: number;
  readonly verdict: "pass" | "fail" | "timeout" | "error";
}

export interface ImplementResult {
  readonly status: AgentRunResult["status"];
  /** Final assistant text (null on non-completed statuses). */
  readonly summary: string | null;
  readonly rounds: number;
  readonly toolCalls: number;
  readonly denials: number;
  readonly pendingApproval: AgentRunResult["pendingApproval"];
  /** Every test.exec verdict observed, in order (for evidence + prompts). */
  readonly testVerdicts: readonly TestVerdict[];
  readonly transcript: AgentRunResult["transcript"];
}

const VERDICT_RE = /test\.exec verdict: (pass|fail|timeout|error)\b/;

function extractVerdicts(transcript: AgentRunResult["transcript"]): readonly TestVerdict[] {
  const out: TestVerdict[] = [];
  for (const m of transcript) {
    if (m.role !== "tool") continue;
    const match = VERDICT_RE.exec(m.content);
    if (match !== null) {
      out.push({ round: out.length + 1, verdict: match[1] as TestVerdict["verdict"] });
    }
  }
  return Object.freeze(out);
}

export function implement(
  deps: {
    readonly runner: ToolRunner;
    readonly jailRoot: string;
    readonly policyCtx: PolicyContext;
    readonly transport: AgentTransport;
    readonly task: ImplementerTaskSpec;
    /** Set by the orchestrator AFTER Plan §33 approval evidence exists. */
    readonly approved?: boolean;
  },
  opts: AgentRunOptions = {},
): Promise<ImplementResult> {
  const agent = new AgentRunner({
    runner: deps.runner,
    manifest: BUILTIN_MANIFESTS.implementer,
    jailRoot: deps.jailRoot,
    policyCtx: deps.policyCtx,
    transport: deps.transport,
    ...(deps.approved === true ? { approved: true } : {}),
  });
  const userPrompt = [
    `TASK (implement): ${deps.task.title}`,
    "",
    "APPROVED PLAN (input):",
    "<<<PLAN (untrusted context)>>>",
    deps.task.plan,
    "<<<END-PLAN>>>",
    "",
    "Implement the plan minimally, verify with test.exec, and feed failures back.",
    "Rules of the lane:",
    "  * Prefer fs.edit (literal replace) over fs.write overwrites; blind rewrites are",
    "    approval-gated by policy and will stall the run.",
    "  * Overwriting existing files requires human approval; if a call stalls as",
    "    APPROVAL_REQUIRED, STOP immediately — do not retry.",
    "  * Run test.exec after each change; you have at most",
    `    ${MAX_IMPLEMENT_FIX_ATTEMPTS} failing rounds before the task must stop.`,
    "  * git.exec mutating subcommands are approval-gated — do not attempt commits.",
    "",
    "Finish with an IMPLEMENTATION SUMMARY: changed files, test verdict, remaining risks.",
  ].join("\n");
  return agent.run(userPrompt, opts).then((res) => ({
    status: res.status,
    summary: res.finalText,
    rounds: res.rounds,
    toolCalls: res.toolCalls,
    denials: res.denials,
    pendingApproval: res.pendingApproval,
    testVerdicts: extractVerdicts(res.transcript),
    transcript: res.transcript,
  }));
}
