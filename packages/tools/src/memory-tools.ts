// memory.read / memory.write tools — Plan §25/§18. Thin governed adapters over
// MemoryService: the runner performs envelope+schema validation and the policy
// funnel (grants), the service enforces scope isolation, secret refusal and caps.
// Policy: memory.read is low-risk, memory.write is medium (state mutation).
import {
  MemoryError,
  validateRef,
  MEMORY_KEY_MAX,
  MEMORY_VALUE_JSON_MAX,
  type MemoryRef,
  type MemoryService,
} from "../../memory/src/index.ts";
import { ToolError, type Tool } from "./runtime.ts";

const SCOPE_ARG = { type: "string", required: true, maxLength: 16 } as const;
const ID_ARGS = {
  projectId: { type: "string", maxLength: 64 },
  taskId: { type: "string", maxLength: 64 },
  modelId: { type: "string", maxLength: 64 },
} as const;

function refFromArgs(args: Readonly<Record<string, unknown>>): MemoryRef {
  return validateRef({
    scope: String(args["scope"]) as MemoryRef["scope"],
    projectId: typeof args["projectId"] === "string" ? args["projectId"] : "",
    taskId: typeof args["taskId"] === "string" ? args["taskId"] : "",
    modelId: typeof args["modelId"] === "string" ? args["modelId"] : "",
  });
}

function toToolError(err: unknown): ToolError {
  if (err instanceof ToolError) return err;
  if (err instanceof MemoryError) {
    const code = err.code === "SECRET_REFUSED" || err.code === "ESCAPE" ? "POLICY_DENIED" : "VALIDATION_ERROR";
    return new ToolError(code, err.message, [err.message]);
  }
  return new ToolError("EXECUTION_FAILED", err instanceof Error ? err.message : String(err));
}

export function createMemoryTools(service: MemoryService): readonly Tool[] {
  const memoryRead: Tool = {
    id: "memory.read",
    description: "Read exact-scope memory entries (T20-isolated; values redacted on display).",
    defaultRisk: "low",
    argsSchema: {
      scope: SCOPE_ARG,
      key: { type: "string", maxLength: MEMORY_KEY_MAX },
      prefix: { type: "string", maxLength: 64 },
      ...ID_ARGS,
    },
    preflight: () => ({}),
    run(args, _ctx) {
      try {
        const ref = refFromArgs(args);
        if (typeof args["key"] === "string") {
          const row = service.get(ref, args["key"]);
          return JSON.stringify({ found: row !== undefined, entry: row ?? null });
        }
        const rows = service.list(ref, {
          ...(typeof args["prefix"] === "string" ? { prefix: args["prefix"] } : {}),
          limit: 200,
        });
        return JSON.stringify({ scope: ref.scope, count: rows.length, entries: rows }, null, 0);
      } catch (err) {
        throw toToolError(err);
      }
    },
  };

  const memoryWrite: Tool = {
    id: "memory.write",
    description: "Upsert a memory entry (secret-shaped values refused; audited content-free).",
    defaultRisk: "medium",
    argsSchema: {
      scope: SCOPE_ARG,
      key: { type: "string", required: true, maxLength: MEMORY_KEY_MAX },
      value: { type: "string", required: true, maxLength: MEMORY_VALUE_JSON_MAX },
      ttlHours: { type: "number" },
      expiresAt: { type: "string", maxLength: 40 },
      ...ID_ARGS,
    },
    preflight: () => ({}),
    run(args, ctx) {
      try {
        const row = service.set({
          ...refFromArgs(args),
          key: String(args["key"]),
          value: String(args["value"]),
          actor: ctx.actor,
          ...(typeof args["ttlHours"] === "number" ? { ttlHours: args["ttlHours"] } : {}),
          ...(typeof args["expiresAt"] === "string" ? { expiresAt: args["expiresAt"] } : {}),
        });
        return `memory.write ok scope=${row.scope} key=${row.key} bytes=${row.valueJson.length}`;
      } catch (err) {
        throw toToolError(err);
      }
    },
  };

  return Object.freeze([memoryRead, memoryWrite]);
}
