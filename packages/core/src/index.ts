// @ai-coding-env/core — shared kernel types. Dependency-free by policy.
export { ok, fail, isOk } from "./result.ts";
export type { Result, Ok, Fail, KernelError } from "./result.ts";
export { TRANSITIONS, TERMINAL_STATES, canTransition, isTerminal } from "./states.ts";
export type { TaskState, TerminalState, FailureState } from "./states.ts";

/** Risk tiers — Plan §33. */
export type RiskLevel = "low" | "medium" | "high";

export const RISK_ORDER: Readonly<Record<RiskLevel, number>> = Object.freeze({
  low: 0,
  medium: 1,
  high: 2,
});

export function riskAtLeast(actual: RiskLevel, minimum: RiskLevel): boolean {
  return RISK_ORDER[actual] >= RISK_ORDER[minimum];
}

/** Data classification — Plan §36. Higher = more restricted. */
export type DataClassification = "public" | "internal" | "confidential" | "restricted";

export const CLASSIFICATION_ORDER: Readonly<Record<DataClassification, number>> =
  Object.freeze({ public: 0, internal: 1, confidential: 2, restricted: 3 });

/** True when `contextLevel` is allowed to flow to a provider cleared for `providerMax`. */
export function classificationAllowed(
  contextLevel: DataClassification,
  providerMax: DataClassification,
): boolean {
  return CLASSIFICATION_ORDER[contextLevel] <= CLASSIFICATION_ORDER[providerMax];
}

/** Branded identifiers — never conflated at the type level. */
export type AgentId = string & { readonly __brand: "AgentId" };
export type ModelId = string & { readonly __brand: "ModelId" };
export type ProviderId = string & { readonly __brand: "ProviderId" };
export type TaskId = string & { readonly __brand: "TaskId" };
export type RunId = string & { readonly __brand: "RunId" };

export function agentId(v: string): AgentId {
  return v as AgentId;
}
export function modelId(v: string): ModelId {
  return v as ModelId;
}
export function providerId(v: string): ProviderId {
  return v as ProviderId;
}
export function taskId(v: string): TaskId {
  return v as TaskId;
}
export function runId(v: string): RunId {
  return v as RunId;
}
