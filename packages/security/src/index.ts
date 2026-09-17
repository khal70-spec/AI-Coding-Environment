// @ai-coding-env/security — dependency-free classifiers. Fail closed, pure logic.
export { SECRET_PATTERNS, redactionToken } from "./secret-patterns.ts";
export type { SecretPattern } from "./secret-patterns.ts";
export { redact, containsSecret, detectSecretKinds } from "./redact.ts";
export type { RedactionResult } from "./redact.ts";
export { classifyCommand, looksLikeRawShell } from "./commands.ts";
export type { CommandRisk, CommandVerdict } from "./commands.ts";
export { isWithinRoot, resolveWithinRoot, assertContainedSync } from "./paths.ts";
export type { ContainmentError } from "./paths.ts";
export { checkEgress, checkRedirect, defaultPort } from "./ssrf.ts";
export type { AllowEntry, EgressVerdict } from "./ssrf.ts";
export { detectSuspiciousInstructions, maxSeverity } from "./injection.ts";
export type { InjectionFinding } from "./injection.ts";
