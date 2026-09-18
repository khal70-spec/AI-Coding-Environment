// UI bridge kernel (Plan §28, ADR-001, P7.1): the ONLY path from any UI surface to
// app logic. Contract, server-agnostic (Tauri IPC, HTTP, stdio — same registry):
//   - deny everything unknown (allowlist by command id);
//   - args validated structurally (types + bounds + enums) BEFORE the handler runs,
//     mirroring the tools runtime's envelope pattern (never crashes, never coerces);
//   - every response is a plain JSON value; errors are stable codes + trimmed text;
//   - handlers receive the UI LOCATOR (project/task scope), never raw SQL.
// Content caveat: agent transcripts/plans are UNTRUSTED model output — the bridge
// marks them display-only; any UI that renders HTML MUST re-escape.
import { createHash } from "node:crypto";


export interface BridgeArgSpec {
  readonly type: "string" | "integer" | "boolean";
  readonly required?: boolean;
  readonly max?: number; // string length bound / integer absolute bound
  readonly enum?: readonly string[];
  readonly pattern?: RegExp;
}

export const BRIDGE_VERSION = "1";

export type BridgeErrorCode =
  | "UNKNOWN_COMMAND"
  | "BAD_ARGS"
  | "HANDLER_FAILED"
  | "NOT_FOUND";

export type BridgeReply =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly code: BridgeErrorCode; readonly message: string };

export interface BridgeCommand<S> {
  readonly id: string;
  readonly args: Readonly<Record<string, BridgeArgSpec>>;
  readonly run: (services: S, args: Record<string, unknown>) => unknown | Promise<unknown>;
}

export interface BridgeInbound {
  readonly command: string;
  readonly args?: unknown;
}

function validateArgs(
  spec: Readonly<Record<string, BridgeArgSpec>>,
  raw: unknown,
): { ok: true; args: Record<string, unknown> } | { ok: false; message: string } {
  if (raw === undefined || raw === null) raw = {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, message: "args must be an object" };
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    // Never `in` on a caller object (prototype-chain keys smuggle through).
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      return { ok: false, message: `forbidden arg: ${key}` };
    }
    if (!Object.hasOwn(spec, key)) return { ok: false, message: `unexpected arg: ${key}` };
  }
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [name, rule] of Object.entries(spec)) {
    const v = obj[name];
    if (v === undefined) {
      if (rule.required === true) return { ok: false, message: `missing arg: ${name}` };
      continue;
    }
    switch (rule.type) {
      case "string": {
        if (typeof v !== "string") return { ok: false, message: `${name}: expected string` };
        if (rule.max !== undefined && v.length > rule.max) return { ok: false, message: `${name}: too long` };
        if (rule.pattern !== undefined && !rule.pattern.test(v)) return { ok: false, message: `${name}: bad pattern` };
        if (rule.enum !== undefined && !rule.enum.includes(v)) return { ok: false, message: `${name}: not one of ${rule.enum.join("|")}` };
        out[name] = v;
        break;
      }
      case "integer": {
        if (typeof v !== "number" || !Number.isInteger(v)) return { ok: false, message: `${name}: expected integer` };
        if (rule.max !== undefined && Math.abs(v) > rule.max) return { ok: false, message: `${name}: out of bounds` };
        out[name] = v;
        break;
      }
      case "boolean": {
        if (typeof v !== "boolean") return { ok: false, message: `${name}: expected boolean` };
        out[name] = v;
        break;
      }
    }
  }
  return { ok: true, args: out };
}

export class BridgeRegistry<S> {
  private readonly commandMap = new Map<string, BridgeCommand<S>>();
  constructor(commands: readonly BridgeCommand<S>[]) {
    for (const c of commands) {
      if (this.commandMap.has(c.id)) throw new Error(`duplicate bridge command: ${c.id}`);
      this.commandMap.set(c.id, c);
    }
  }

  ids(): readonly string[] {
    return Object.freeze([...this.commandMap.keys()].sort());
  }

  /** Dispatch one inbound call; NEVER throws — stable reply lanes only. */
  async dispatch(services: S, inbound: BridgeInbound): Promise<BridgeReply> {
    const cmd = this.commandMap.get(inbound.command);
    if (cmd === undefined) {
      return Object.freeze({ ok: false, code: "UNKNOWN_COMMAND", message: `unknown command: ${inbound.command}` });
    }
    const v = validateArgs(cmd.args, inbound.args);
    if (!v.ok) {
      return Object.freeze({ ok: false, code: "BAD_ARGS", message: v.message });
    }
    try {
      const data = await cmd.run(services, v.args);
      return Object.freeze({ ok: true, data: data === undefined ? null : data });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code: BridgeErrorCode = /not found/.test(msg) ? "NOT_FOUND" : "HANDLER_FAILED";
      return Object.freeze({ ok: false, code, message: msg.slice(0, 300) });
    }
  }
}

/** Fingerprint for audit-adjacent fingerprints (stable, content-agnostic). */
export function bridgeFingerprint(ids: readonly string[]): string {
  return createHash("sha256").update([...ids].sort().join("|")).digest("hex").slice(0, 16);
}
