// @ai-coding-env/tools — Plan §18. Phase 0: call/result envelope + validation contract.
// Executors (fs/search/terminal/git/tests/browser) land in Phase 3. Every executor MUST:
//  1. validate args via its schema, 2. pass policy.evaluate, 3. redact output, 4. audit.
import type { DataClassification, RiskLevel } from "../../core/src/index.ts";

export interface ToolCall {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly cwd: string;
  readonly risk: RiskLevel;
  readonly classification: DataClassification;
}

export interface ToolResult {
  readonly ok: boolean;
  /** Redacted output — executors must pass raw output through redact() first. */
  readonly output: string;
  readonly redactedKinds: readonly string[];
  readonly durationMs: number;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly defaultRisk: RiskLevel;
  /** Pure arg validation. Return error strings; empty = valid. */
  readonly validateArgs: (args: Readonly<Record<string, unknown>>) => readonly string[];
}

export function validateToolCall(call: ToolCall): readonly string[] {
  const errors: string[] = [];
  if (call.tool.trim() === "") errors.push("tool name required");
  if (call.cwd.trim() === "") errors.push("cwd required");
  if (typeof call.args !== "object" || call.args === null) errors.push("args must be an object");
  return Object.freeze(errors);
}
