// @ai-coding-env/mcp — Plan §17, ADR-005. Phase 0: config model + validation.
// Registry, OAuth, transport, and tool proxying land in Phase 6.

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
    if (c.url === undefined || c.url === "") errors.push("url required for http/sse");
    else if (!c.url.startsWith("https://")) errors.push("http/sse MCP servers must use https");
  }
  if (c.transport === "stdio" && (c.command === undefined || c.command.length === 0)) {
    errors.push("command argv required for stdio");
  }
  if (c.toolsAllow.includes("*")) errors.push("wildcard tool grant forbidden for MCP servers");
  if (c.resourcesAllow.includes("*")) errors.push("wildcard resource grant forbidden");
  if (c.trust === "high" && !c.audited) errors.push("high trust requires recorded security review");
  if (c.credentialRef !== undefined && !c.credentialRef.startsWith("vault://")) {
    errors.push("credentials must be vault refs (vault://…)");
  }
  return Object.freeze(errors);
}
