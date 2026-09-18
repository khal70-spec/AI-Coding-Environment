// @ai-coding-env/mcp — Plan §17, ADR-005. Phase 0: config model + validation.
// Registry, OAuth, transport, and tool proxying land in Phase 6.

import { assertMcpEndpointShape } from "./endpoints.ts";

export type McpTrust = "low" | "medium" | "high";
export type McpTransport = "stdio" | "http" | "sse";

export interface McpServerConfig {
  readonly id: string;
  readonly name: string;
  readonly transport: McpTransport;
  readonly trust: McpTrust;
  readonly url?: string; // http/sse only
  readonly command?: readonly string[]; // stdio only (argv, validated at install)
  readonly toolsAllow: readonly string[];
  readonly toolsDeny: readonly string[];
  readonly resourcesAllow: readonly string[];
  readonly networkAllow: readonly string[]; // host allowlist
  readonly credentialRef?: string; // vault://… — never inline

  readonly audited: boolean;
}

/** Validate config. Empty = valid. Deny-by-default is structural: empty allow = nothing. */
export function validateMcpConfig(c: McpServerConfig): readonly string[] {
  const errors: string[] = [];
  if (c.id.trim() === "") errors.push("id required");
  if (c.name.trim() === "") errors.push("name required");
  if (c.transport === "http" || c.transport === "sse") {
    const ep = assertMcpEndpointShape(c.transport, c.url);
    if (!ep.ok) errors.push(ep.reason);
  }
  if (c.transport === "stdio" && (c.command === undefined || c.command.length === 0)) {
    errors.push("command argv required for stdio");
  }
  if (c.toolsAllow.includes("*")) errors.push("wildcard tool grant forbidden for MCP servers");
  if (c.toolsDeny.includes("*")) errors.push("wildcard in toolsDeny makes the server inert — use explicit entries");
  if (c.resourcesAllow.includes("*")) errors.push("wildcard resource grant forbidden");
  if (c.trust === "high" && !c.audited) errors.push("high trust requires recorded security review");
  if (c.credentialRef !== undefined && !c.credentialRef.startsWith("vault://")) {
    errors.push("credentials must be vault refs (vault://…)");
  }
  return Object.freeze(errors);
}

// Phase 6: registry gates, contained client, skill bundles.
export { decideMcpCall, mcpEndpointVerdict, assertMcpEndpoint } from "./gates.ts";
export type { McpDecision, McpDenyCode, McpPermissionView, McpCallRequest } from "./gates.ts";
export { McpClient, MCP_MAX_RESPONSE_BYTES, MCP_DEFAULT_TIMEOUT_MS } from "./client.ts";
export type { JsonRpcResponse, McpClientDeps } from "./client.ts";
export { digestSkillBundle, parseSkillManifest, decideSkillUse, SKILL_MANIFEST_FILE, MAX_SKILL_BYTES } from "./skills.ts";
export type { SkillManifest, SkillUseDecision } from "./skills.ts";
