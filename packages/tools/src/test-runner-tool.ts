// test.exec — Plan §22 (P3.3). The ONLY way agents run a project's test suite:
// stack-detected allowlisted argv (never user-composed), cwd-jailed, env-sanitized,
// timeout-killed (group), byte-capped. Returns a NORMALIZED verdict so `verify`
// (P3.4+) can record evidence without parsing per-framework output formats.
import { execArgv, TERMINAL_MAX_OUTPUT_BYTES } from "./terminal.ts";
import { detectStack, type StackInfo } from "./stack-detect.ts";
import { assertContainedSync } from "../../security/src/paths.ts";
import { ToolError, type Tool } from "./runtime.ts";

export interface NormalizedTestResult {
  readonly stack: StackInfo["kind"];
  readonly marker: string | null;
  readonly argv: readonly string[];
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  /** One-word machine verdict: pass (exit 0), fail (non-zero), error (spawn/other), timeout. */
  readonly verdict: "pass" | "fail" | "error" | "timeout";
  readonly durationMs: number;
  /** Capped combined output tail (after full-text scan; never the full stream). */
  readonly tailLog: string;
}

const EXTRA_ARG_LIMIT = 16;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

export function normalizeTestResult(
  info: StackInfo,
  argv: readonly string[],
  exec: { exitCode: number | null; timedOut: boolean; stdout: string; stderr: string },
  durationMs: number,
): NormalizedTestResult {
  const combined = `${exec.stdout}\n${exec.stderr}`;
  const tail = combined.slice(-4096);
  const verdict: NormalizedTestResult["verdict"] =
    exec.timedOut ? "timeout" : exec.exitCode === null ? "error" : exec.exitCode === 0 ? "pass" : "fail";
  return Object.freeze({
    stack: info.kind,
    marker: info.marker,
    argv,
    exitCode: exec.exitCode,
    timedOut: exec.timedOut,
    verdict,
    durationMs,
    tailLog: tail,
  });
}

export const testExec: Tool = {
  id: "test.exec",
  description:
    "Run the detected stack's allowlisted test argv inside the jail; normalized verdict + capped tail.",
  defaultRisk: "medium",
  argsSchema: {
    /**
     * Extra argv appended AFTER the allowlisted prefix (e.g. ["--","--grep","foo"] for npm).
     * Still argv-data (never shell), capped at 16 items.
     */
    extraArgs: { type: "string[]", maxItems: EXTRA_ARG_LIMIT, maxLength: 256 },
    timeoutMs: { type: "number" },
  },
  preflight(_args, ctx) {
    const info = detectStack(ctx.jailRoot);
    if (info.kind === "unknown" || info.testArgv === null) {
      // No recognizable project: refuse at the policy layer rather than executing nothing.
      return { fsScope: "workspace", neverAllow: true, dangerous: true };
    }
    // Running the repo's own test suite executes repo code → always an ack-worthy op.
    return { fsScope: "workspace", dangerous: false, riskOverride: "medium" };
  },
  async run(args, ctx) {
    const cwd = assertContainedSync(ctx.jailRoot, ".");
    if (!cwd.ok) throw new ToolError("JAIL_ESCAPE", cwd.error.message);
    const info = detectStack(ctx.jailRoot);
    if (info.kind === "unknown" || info.testArgv === null) {
      throw new ToolError("EXECUTION_FAILED", "no testable stack detected (add package.json/requirements.txt/…)");
    }
    const extra = ((args["extraArgs"] as string[] | undefined) ?? []).map(String);
    const argv = [...info.testArgv, ...extra];
    const timeoutMs = Math.min(
      Math.max(Number(args["timeoutMs"] ?? DEFAULT_TIMEOUT_MS), 1_000),
      MAX_TIMEOUT_MS,
    );
    const started = Date.now();
    const res = await execArgv(argv, {
      cwd: cwd.path,
      timeoutMs,
      maxBytes: TERMINAL_MAX_OUTPUT_BYTES,
    });
    const norm = normalizeTestResult(info, argv, res, Date.now() - started);
    return [
      `test.exec verdict: ${norm.verdict} (stack ${norm.stack} via ${norm.marker ?? "?"})`,
      `argv: ${norm.argv.join(" ")}`,
      `exit: ${norm.exitCode === null ? "null" : norm.exitCode}  duration: ${norm.durationMs}ms${norm.timedOut ? "  [timeout]" : ""}`,
      norm.tailLog.trim() !== "" ? `--- output tail (≤4KiB) ---\n${norm.tailLog.trim()}` : "(no output)",
    ].join("\n");
  },
};

export const TEST_RUNNER_TOOLS: readonly Tool[] = Object.freeze([testExec]);
