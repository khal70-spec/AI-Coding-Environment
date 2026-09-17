// Tool runtime — Plan §18/§19 (P3.1). The ONLY way tools run:
//   envelope validate → registry lookup → arg schema validate → preflight
//   → policy.evaluate → (deny | approval | allow) → execute (timeout + byte cap)
//   → redact + trust-tag output → audit
// Denials and approval gates do NOT execute the tool. Approval flow elsewhere
// (Phase 4 orchestration) re-calls after recording approval evidence.
import { evaluate, type AgentGrant, type PolicyContext, type ToolRequest } from "../../policy/src/index.ts";
import { redact } from "../../security/src/redact.ts";
import { assertContainedSync } from "../../security/src/paths.ts";
import type { DataClassification, RiskLevel } from "../../core/src/index.ts";
import type { ToolCall, ToolResult } from "./index.ts";
import { validateToolCall } from "./index.ts";

export type ToolErrorCode =
  | "TOOL_NOT_FOUND"
  | "VALIDATION_ERROR"
  | "POLICY_DENIED"
  | "APPROVAL_REQUIRED"
  | "EXECUTION_FAILED"
  | "TIMEOUT"
  | "OUTPUT_CAPPED"
  | "JAIL_ESCAPE";

export class ToolError extends Error {
  readonly code: ToolErrorCode;
  readonly reasons: readonly string[];
  constructor(code: ToolErrorCode, message: string, reasons: readonly string[] = []) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.reasons = Object.freeze([...reasons]);
  }
}

export type ArgRule =
  | { readonly type: "string" | "number" | "boolean"; readonly required?: boolean; readonly maxLength?: number }
  | { readonly type: "string[]"; readonly required?: boolean; readonly maxItems?: number; readonly maxLength?: number };

function validateSchema(
  schema: Readonly<Record<string, ArgRule>>,
  args: Readonly<Record<string, unknown>>,
): readonly string[] {
  const errors: string[] = [];
  for (const [key, rule] of Object.entries(schema)) {
    const v = args[key];
    if (v === undefined) {
      if (rule.required) errors.push(`arg ${key} required (${rule.type})`);
      continue;
    }
    switch (rule.type) {
      case "string":
        if (typeof v !== "string") errors.push(`arg ${key} must be a string`);
        else if (v.includes("\u0000")) errors.push(`arg ${key} must not contain NUL bytes`);
        else if (rule.maxLength !== undefined && v.length > rule.maxLength) {
          errors.push(`arg ${key} exceeds ${rule.maxLength} chars`);
        }
        break;
      case "number":
        if (typeof v !== "number" || !Number.isFinite(v)) errors.push(`arg ${key} must be a finite number`);
        break;
      case "boolean":
        if (typeof v !== "boolean") errors.push(`arg ${key} must be a boolean`);
        break;
      case "string[]": {
        if (!Array.isArray(v) || v.some((a) => typeof a !== "string")) {
          errors.push(`arg ${key} must be a string array`);
        } else {
          if (rule.maxItems !== undefined && v.length > rule.maxItems) {
            errors.push(`arg ${key} exceeds ${rule.maxItems} items`);
          }
          const lim = rule.maxLength ?? 512;
          if ((v as string[]).some((a) => a.includes("\u0000") || a.length > lim)) {
            errors.push(`arg ${key} items must be NUL-free and ≤ ${lim} chars`);
          }
        }
        break;
      }
    }
  }
  // Unknown args are rejected — a misspelled flag must never silently change behavior.
  for (const key of Object.keys(args)) {
    if (schema[key] === undefined) errors.push(`unknown arg: ${key}`);
  }
  return Object.freeze(errors);
}

/** Caller's cwd is exposed for fs/terminal resolution; tools MUST jail it. */export interface PreflightHints {
  readonly fsScope?: ToolRequest["fsScope"];
  readonly fsReadScope?: ToolRequest["fsReadScope"];
  readonly networkHost?: string;
  readonly dangerous?: boolean;
  readonly neverAllow?: boolean;
  readonly riskOverride?: RiskLevel;
}

/** The runner's execution context — identity, task posture, grants, jail. */
export interface ToolContext {
  readonly actor: string; // "agent:<name>" or operator id — goes to audit
  readonly risk: RiskLevel; // current task risk
  readonly classification: DataClassification;
  readonly grant: AgentGrant; // resolved from the agent manifest/permissions rows
  readonly policyCtx: PolicyContext;
  /** Containment jail for fs/terminal cwd (workspace or project root). REQUIRED. */
  readonly jailRoot: string;
  /** The caller's cwd from the ToolCall — runner sets it (already jail-proven). */
  readonly callCwd?: string;
  /** Set when explicit human approval evidence exists for this call (Plan §33). */
  readonly approved?: boolean;
  readonly defaultTimeoutMs?: number;
}

/** Structured tool output: text goes through redact/cap/tag; data passes to the caller
 * uninspected except for audit redaction of the STRING only — callers persist rows. */
export interface ToolRunOutput {
  readonly text: string;
  /** Machine-consumable result (findings, normalized tests, fetch metadata). */
  readonly data?: unknown;
}

export interface Tool {
  readonly id: string; // "fs.read", "terminal.exec", …
  readonly description: string;
  readonly defaultRisk: RiskLevel;
  readonly argsSchema: Readonly<Record<string, ArgRule>>;
  preflight(args: Readonly<Record<string, unknown>>, ctx: ToolContext): PreflightHints;
  run(
    args: Readonly<Record<string, unknown>>,
    ctx: ToolContext,
  ): Promise<string | ToolRunOutput> | string | ToolRunOutput;
}

export interface ExtendedResult extends ToolResult {
  readonly code?: ToolErrorCode;
  readonly reasons?: readonly string[];
  /** Structured payload from the tool (scan.findings etc), when provided. */
  readonly data?: unknown;
}

export interface ToolEvent {
  readonly kind: "tool.call.allowed" | "tool.call.denied" | "tool.call.approval_required" | "tool.call.failed";
  readonly actor: string;
  readonly tool: string;
  readonly code?: string;
  /** Redacted, content-free (arg KEYS only, never arg VALUES). */
  readonly detail?: string;
  readonly durationMs?: number;
}

export type ToolAuditSink = (event: ToolEvent) => void;

export const UNTRUSTED_TAG_OPEN = "<<<UNTRUSTED-TOOL-OUTPUT";
export const UNTRUSTED_TAG_CLOSE = "<<<END-UNTRUSTED-TOOL-OUTPUT>>>";

export function trustTag(toolId: string, output: string): string {
  // Untrusted model/tool content markers (Plan §7) — the model consuming this text
  // must treat it as data, not instructions.
  return `${UNTRUSTED_TAG_OPEN} tool="${toolId}">>>\n${output}\n${UNTRUSTED_TAG_CLOSE}`;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
export const TOOL_MAX_OUTPUT_BYTES = 256 * 1024;

export class ToolRunner {
  private readonly tools: ReadonlyMap<string, Tool>;
  private readonly audit?: ToolAuditSink;

  constructor(tools: readonly Tool[], audit?: ToolAuditSink) {
    const map = new Map<string, Tool>();
    for (const t of tools) {
      if (map.has(t.id)) throw new Error(`duplicate tool id: ${t.id}`);
      map.set(t.id, t);
    }
    this.tools = map;
    this.audit = audit;
  }

  ids(): readonly string[] {
    return Object.freeze([...this.tools.keys()]);
  }

  private emit(event: ToolEvent): void {
    this.audit?.(event);
  }

  async call(call: ToolCall, ctx: ToolContext): Promise<ExtendedResult> {
    const started = Date.now();
    const argKeys = Object.keys(call.args).join(",");

    const fail = (code: ToolErrorCode, message: string, reasons: readonly string[] = [], kind: ToolEvent["kind"] = "tool.call.failed"): ExtendedResult => {
      const detail = redact(`${message} [args: ${argKeys}]`).text;
      this.emit({ kind, actor: ctx.actor, tool: call.tool, code, detail, durationMs: Date.now() - started });
      return { ok: false, output: trustTag(call.tool, detail), redactedKinds: [], durationMs: Date.now() - started, code, reasons };
    };

    const envelopeErrors = validateToolCall(call);
    if (envelopeErrors.length > 0) {
      return fail("VALIDATION_ERROR", envelopeErrors.join("; "), envelopeErrors);
    }
    const tool = this.tools.get(call.tool);
    if (tool === undefined) return fail("TOOL_NOT_FOUND", `unknown tool: ${call.tool}`);

    const schemaErrors = validateSchema(tool.argsSchema, call.args);
    if (schemaErrors.length > 0) {
      return fail("VALIDATION_ERROR", schemaErrors.join("; "), schemaErrors);
    }

    let hints: PreflightHints;
    try {
      hints = tool.preflight(call.args, { ...ctx, callCwd: call.cwd });
    } catch (err) {
      return fail(
        "VALIDATION_ERROR",
        `preflight failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const request: ToolRequest = {
      tool: tool.id,
      risk: hints.riskOverride ?? call.risk ?? tool.defaultRisk,
      classification: call.classification ?? ctx.classification,
      dangerous: hints.dangerous === true,
      neverAllow: hints.neverAllow === true,
      fsScope: hints.fsScope,
      fsReadScope: hints.fsReadScope,
      networkHost: hints.networkHost,
      approved: ctx.approved === true,
    };
    // Jail gate: anything with an fsScope (fs.*) or a terminal tool runs cwd-jailed —
    // the call's cwd must provably be inside the jail before policy even evaluates.
    if (hints.fsScope !== undefined || hints.fsReadScope !== undefined || tool.id.startsWith("terminal.")) {
      const jail = assertContainedSync(ctx.jailRoot, call.cwd);
      if (!jail.ok) {
        return fail(
          "JAIL_ESCAPE",
          `cwd escapes jail root: ${jail.error.message}`,
          [jail.error.message],
          "tool.call.denied",
        );
      }
    }

    const verdict = evaluate(request, ctx.grant, ctx.policyCtx);
    if (verdict.decision === "deny") {
      return fail("POLICY_DENIED", `policy deny: ${verdict.reasons.join("; ")}`, verdict.reasons, "tool.call.denied");
    }
    if (verdict.decision === "approval") {
      return fail(
        "APPROVAL_REQUIRED",
        `requires approval: ${verdict.reasons.join("; ")}`,
        verdict.reasons,
        "tool.call.approval_required",
      );
    }

    // allow — execute with timeout + byte cap + redaction + trust tag.
    const timeoutMs = Math.max(
      1_000,
      Math.min(ctx.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
    );
    let raw: string;
    let data: unknown;
    try {
      const out = await runWithTimeout(tool.run(call.args, { ...ctx, callCwd: call.cwd }), timeoutMs);
      if (typeof out === "string") {
        raw = out;
      } else {
        raw = out.text;
        data = out.data;
      }
    } catch (err) {
      if (err instanceof ToolError) {
        return fail(err.code, err.message, err.reasons);
      }
      const msg = err instanceof TimeoutError ? `tool timed out after ${timeoutMs}ms` : `${err instanceof Error ? err.message : String(err)}`;
      return fail(err instanceof TimeoutError ? "TIMEOUT" : "EXECUTION_FAILED", msg);
    }

    let outputRedacted = redact(raw);
    let capped = false;
    const byteLength = Buffer.byteLength(outputRedacted.text, "utf8");
    if (byteLength > TOOL_MAX_OUTPUT_BYTES) {
      const buf = Buffer.from(outputRedacted.text, "utf8");
      outputRedacted = {
        text: buf.subarray(0, TOOL_MAX_OUTPUT_BYTES).toString("utf8") + "\n[output capped]",
        hits: outputRedacted.hits,
        redacted: outputRedacted.redacted,
      };
      capped = true;
    }
    const tagged = trustTag(tool.id, outputRedacted.text);
    this.emit({
      kind: "tool.call.allowed",
      actor: ctx.actor,
      tool: tool.id,
      detail: redact(`ok [args: ${argKeys}]${capped ? " [output capped]" : ""}`).text,
      durationMs: Date.now() - started,
    });
    return {
      ok: true,
      output: tagged,
      redactedKinds: outputRedacted.hits,
      durationMs: Date.now() - started,
      ...(capped ? { code: "OUTPUT_CAPPED" as const } : {}),
      ...(data !== undefined ? { data } : {}),
    };
  }
}

class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

function runWithTimeout<T>(work: Promise<T> | T, timeoutMs: number): Promise<T> {
  return Promise.race([
    Promise.resolve(work),
    new Promise<T>((_resolve, reject) => {
      const t = setTimeout(() => reject(new TimeoutError(`timeout after ${timeoutMs}ms`)), timeoutMs);
      t.unref?.();
    }),
  ]);
}
