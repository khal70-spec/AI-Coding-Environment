// @ai-coding-env/providers — Plan §10–13, ADR-002.
// Interface + registry. Network adapters land in Phase 2; NOTHING here performs I/O.

export type ProviderProtocol =
  | "openai-chat"
  | "openai-responses"
  | "anthropic-messages"
  | "gemini"
  | "nvidia-nim"
  | "generic-rest"
  | "local-openai-compatible";

export type ModelCapability =
  | "text"
  | "vision"
  | "audio"
  | "tools"
  | "structured-output"
  | "reasoning"
  | "coding"
  | "long-context"
  | "streaming"
  | "parallel-tools"
  | "computer-use"
  | "embeddings"
  | "image-generation";

export type ModelStatus = "available" | "degraded" | "unavailable" | "unverified";

/** Normalized model record — Plan §12. A model is configuration, not architecture. */
export interface ModelRecord {
  readonly id: string;
  readonly providerId: string;
  readonly displayName: string;
  readonly capabilities: Readonly<Record<ModelCapability, boolean>>;
  readonly contextWindow: number;
  /** Declared by provider; trusted only after capability tests pass. */
  readonly declaredCapabilitiesVerified: boolean;
  readonly status: ModelStatus;
  readonly maxOutputTokens?: number;
  readonly costPerMTokIn?: number;
  readonly costPerMTokOut?: number;
}

export function emptyCapabilities(): Record<ModelCapability, boolean> {
  return {
    text: false,
    vision: false,
    audio: false,
    tools: false,
    "structured-output": false,
    reasoning: false,
    coding: false,
    "long-context": false,
    streaming: false,
    "parallel-tools": false,
    "computer-use": false,
    embeddings: false,
    "image-generation": false,
  };
}

export interface ProviderHealth {
  readonly ok: boolean;
  readonly latencyMs?: number;
  readonly checkedAt: string;
  readonly detail?: string;
}

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
}

export interface ChatRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly maxTokens?: number;
  readonly temperature?: number;
}

export interface ChatResponse {
  readonly model: string;
  readonly content: string;
  readonly finishReason: "stop" | "length" | "tool_calls" | "error";
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
}

/** Common provider interface — every adapter implements this (ADR-002). */
export interface Provider {
  readonly id: string;
  readonly name: string;
  readonly protocol: ProviderProtocol;
  readonly baseUrl: string;
  listModels(): Promise<readonly ModelRecord[]>;
  complete(request: ChatRequest): Promise<ChatResponse>;
  health(): Promise<ProviderHealth>;
}

export interface ModelRegistry {
  register(model: ModelRecord): void;
  get(id: string): ModelRecord | undefined;
  list(): readonly ModelRecord[];
  listByCapability(cap: ModelCapability): readonly ModelRecord[];
  setStatus(id: string, status: ModelStatus): void;
}

export function validateModelRecord(m: ModelRecord): readonly string[] {
  const errors: string[] = [];
  if (m.id.trim() === "") errors.push("model id required");
  if (m.providerId.trim() === "") errors.push("provider id required");
  if (!Number.isInteger(m.contextWindow) || m.contextWindow <= 0) {
    errors.push("contextWindow must be a positive integer");
  }
  return Object.freeze(errors);
}

export class InMemoryRegistry implements ModelRegistry {
  private readonly models = new Map<string, ModelRecord>();

  register(model: ModelRecord): void {
    const errors = validateModelRecord(model);
    if (errors.length > 0) throw new Error(`invalid model record: ${errors.join("; ")}`);
    this.models.set(model.id, { ...model, status: model.declaredCapabilitiesVerified ? model.status : "unverified" });
  }

  get(id: string): ModelRecord | undefined {
    return this.models.get(id);
  }

  list(): readonly ModelRecord[] {
    return Object.freeze([...this.models.values()]);
  }

  listByCapability(cap: ModelCapability): readonly ModelRecord[] {
    return Object.freeze(this.list().filter((m) => m.capabilities[cap] && m.status === "available"));
  }

  setStatus(id: string, status: ModelStatus): void {
    const m = this.models.get(id);
    if (m === undefined) throw new Error(`unknown model: ${id}`);
    this.models.set(id, { ...m, status });
  }
}

// ─────────────────────────────── Phase 2 runtime ───────────────────────────────
// The interface above stays dependency-free; adapters/dispatcher live in modules that
// policy-forbid network access except through the egress-checked transport.

export { ProviderError, TRANSIENT_CODES, isTransientProviderError } from "./errors.ts";
export type { ProviderErrorCode } from "./errors.ts";
export {
  assertProviderEndpoint,
  urlFor,
  fetchTransport,
  statusToProviderError,
  parseProviderJson,
  dotPath,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RESPONSE_BYTES,
  HEALTH_TIMEOUT_MS,
} from "./http.ts";
export type { Transport, TransportRequest, TransportResponse } from "./http.ts";
export { BaseAdapter } from "./base.ts";
export type { ProviderConfig, AdapterDeps } from "./base.ts";
export {
  OpenAIChatAdapter,
  NvidiaNimAdapter,
  AnthropicAdapter,
  GenericRestAdapter,
  createAdapter,
  toModelRecord,
  PROTOCOL_DEFAULT_BASE,
} from "./adapters.ts";
export { ProviderDispatcher } from "./dispatcher.ts";
export type {
  ConnectionReport,
  DispatcherDeps,
  ProviderEvent,
  ProviderEventSink,
} from "./dispatcher.ts";

// ─────────────────────────────── Phase 2: registry + router ───────────────────────────────
export {
  discoverIntoDb,
  probeModel,
  probeAll,
  DbModelRegistry,
} from "./registry.ts";
export type { DiscoveryReport, ProbeReport } from "./registry.ts";
export { FailoverRouter, DEFAULT_HEALTH_TTL_MS } from "./router.ts";
export type { Candidate, RouterDeps } from "./router.ts";

// ─────────────────────────────── Phase 2: budgets ───────────────────────────────
export { BudgetEnforcer, windowStartIso } from "./budget.ts";
export type { BudgetDeps, BudgetHook, GuardArgs, RecordArgs } from "./budget.ts";
