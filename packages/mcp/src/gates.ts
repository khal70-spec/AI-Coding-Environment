// MCP gates (P6.1, Plan §17, ADR-005): every server call is decided BEFORE any
// transport work. Deny-order is fixed (config → kill-switch → endpoint → allowlist →
// permission rows → trust floor); results carry a reason for the audit trail.
import type { McpServerConfig } from "./index.ts";
import { validateMcpConfig } from "./index.ts";
import { assertMcpEndpointShape } from "./endpoints.ts";
import { checkEgress, defaultPort } from "../../security/src/ssrf.ts";

export type McpDecision =
  | { readonly allowed: true; readonly reason: string }
  | { readonly allowed: false; readonly reason: string; readonly code: McpDenyCode };

export type McpDenyCode =
  | "CONFIG_INVALID"
  | "SERVER_DISABLED"
  | "ENDPOINT_DENIED"
  | "TOOL_NOT_ALLOWED"
  | "TOOL_DENIED"
  | "PERMISSION_DENIED"
  | "TRUST_FLOOR";

export interface McpPermissionView {
  readonly resource: string;
  readonly effect: "allow" | "deny";
}

/** http/sse endpoint rule (shared shape with install validation). */
export function assertMcpEndpoint(cfg: McpServerConfig): { ok: true } | { ok: false; reason: string } {
  return assertMcpEndpointShape(cfg.transport, cfg.url);
}

/** Parse host:port entries from networkAllow (port optional, scheme-defaulted). */
function parseAllowEntry(h: string): { host: string; port?: number } {
  const m = /^\[([^\]]+)\](?::(\d+))?$|([^:]+)(?::(\d+))?$/.exec(h);
  if (m === null || m === undefined) return Object.freeze({ host: h });
  return Object.freeze({ host: (m[1] ?? m[3] ?? "").toLowerCase(), ...(m[2] ?? m[4] ? { port: Number(m[2] ?? m[4]) } : {}) });
}

/**
 * Egress policy for MCP servers (mirrors the provider exit-node rule):
 *   - https remote → host (+port) must be networkAllow-listed AND pass the SSRF
 *     blocklist (private/metadata hosts dead on arrival);
 *   - http loopback → only loopback targets, and EXACT host:port must be listed
 *     (the operator pins the port at install time);
 *   - everything else → already refused by assertMcpEndpoint.
 */
export function mcpEndpointVerdict(cfg: McpServerConfig): { blocked: boolean; reason: string } {
  const e = assertMcpEndpoint(cfg);
  if (!e.ok) return { blocked: true, reason: e.reason };
  if (cfg.transport === "stdio") return { blocked: false, reason: "stdio argv checked at install" };
  const url = new URL(cfg.url as string);
  const host = url.hostname.toLowerCase();
  const port = url.port === "" ? defaultPort(url.protocol) ?? undefined : Number(url.port);
  const allow = cfg.networkAllow.map(parseAllowEntry);
  if (url.protocol === "http:") {
    const match = allow.find((a) => a.host === host && (a.port ?? 80) === port);
    return match !== undefined
      ? { blocked: false, reason: "loopback endpoint pinned" }
      : { blocked: true, reason: `egress: loopback host:port not pinned in networkAllow (${host}:${String(port)})` };
  }
  const verdict = checkEgress(
    url.origin,
    allow.map((a) => ({
      host: a.host,
      ...(a.port !== undefined ? { port: a.port } : {}),
    })),
  );
  return verdict.allowed ? { blocked: false, reason: "endpoint allowlisted" } : { blocked: true, reason: `egress: ${verdict.reason}` };
}

export interface McpCallRequest {
  readonly server: McpServerConfig;
  readonly enabled: boolean;
  readonly permissionRows?: readonly McpPermissionView[];
  readonly tool: string;
  readonly args?: readonly unknown[];
}

/** Decision goes through the fixed deny ladder; FIRST deny wins (auditable). */
export function decideMcpCall(req: McpCallRequest): McpDecision {
  const cfg = req.server;
  const errors = validateMcpConfig(cfg);
  if (errors.length > 0) {
    return Object.freeze({ allowed: false, code: "CONFIG_INVALID", reason: errors.join("; ") });
  }
  if (!req.enabled) {
    return Object.freeze({ allowed: false, code: "SERVER_DISABLED", reason: `server ${cfg.id} is disabled (kill switch)` });
  }
  const ep = mcpEndpointVerdict(cfg);
  if (ep.blocked) {
    return Object.freeze({ allowed: false, code: "ENDPOINT_DENIED", reason: ep.reason });
  }
  if (cfg.toolsDeny.includes(req.tool)) {
    return Object.freeze({ allowed: false, code: "TOOL_DENIED", reason: `${req.tool} in toolsDeny (never allowed)` });
  }
  if (!cfg.toolsAllow.includes(req.tool)) {
    return Object.freeze({ allowed: false, code: "TOOL_NOT_ALLOWED", reason: `${req.tool} not in toolsAllow (default deny)` });
  }
  for (const row of req.permissionRows ?? []) {
    if (row.effect === "deny" && (row.resource === `mcp:${cfg.id}/${req.tool}` || row.resource === `mcp:${cfg.id}/*`)) {
      return Object.freeze({ allowed: false, code: "PERMISSION_DENIED", reason: `permissions[${row.resource}]=deny` });
    }
  }
  return Object.freeze({ allowed: true, reason: "allowed (tool allowlisted + endpoint verified)" });
}
