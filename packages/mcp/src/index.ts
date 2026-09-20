// @ai-coding-env/mcp — Plan §17, ADR-005. Phase 0: config model + validation.
// Registry, OAuth, transport, and tool proxying land in Phase 6.

import { assertMcpEndpointShape } from "./endpoints.ts";
import { containsSecret } from "../../security/src/redact.ts";
import type { OAuthClientConfig } from "./oauth.ts";

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
  /** OAuth 2.1 remote profile (ADR-005): HTTPS + PKCE via packages/mcp/src/oauth.ts.
   *  Tokens live in the vault under vault://mcp/<id>/oauth/* — never in this config. */
  readonly oauth?: OAuthClientConfig;

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
  if (c.oauth !== undefined) {
    const o = c.oauth;
    if (c.transport === "stdio") errors.push("oauth requires an http/sse transport (remote profile)");
    if (typeof o.clientId !== "string" || o.clientId.trim() === "" || o.clientId.length > 128) {
      errors.push("oauth clientId required (≤128 chars)");
    } else if (containsSecret(o.clientId)) {
      errors.push("oauth clientId looks like a secret — public-client ids only (secrets stay in the vault)");
    }
    if (o.issuer !== undefined) {
      const ep = assertMcpEndpointShape("http", o.issuer);
      if (!ep.ok) errors.push(`oauth issuer: ${ep.reason}`);
    }
    if (o.scopes !== undefined && o.scopes.some((s) => typeof s !== "string" || s.length === 0 || s.length > 64)) {
      errors.push("oauth scopes must be 1..64-char strings");
    }
    if (o.resource !== undefined) {
      const ep = assertMcpEndpointShape("http", o.resource);
      if (!ep.ok) errors.push(`oauth resource: ${ep.reason}`);
    }
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
// Phase 6+: OAuth 2.1 remote profile (ADR-005) — HTTPS + PKCE, vault-held tokens.
export {
  OAuthError,
  assertOAuthEndpoint,
  generatePkcePair,
  generateState,
  discoverAuthorizationServer,
  discoverProtectedResource,
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  refreshAccessToken,
  oauthRefs,
  OAUTH_MAX_RESPONSE_BYTES,
  OAUTH_DEFAULT_TIMEOUT_MS,
} from "./oauth.ts";
export type {
  AuthorizationServerMetadata,
  AuthorizeRequest,
  OAuthClientConfig,
  OAuthDeps,
  OAuthErrorCode,
  TokenSet,
} from "./oauth.ts";
