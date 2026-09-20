// MCP OAuth 2.1 client profile (Plan §17, ADR-005) — remote-server auth done BY
// THE SPEC, never weaker: HTTPS-only endpoints (loopback allowed for local dev),
// authorization-code + PKCE (S256), strict state, protected-resource / AS metadata
// discovery (RFC 9728 / RFC 8414), form-encoded token exchange with structured
// error lanes, byte caps + timeouts + redirect refusal. Tokens are SECRETS: this
// module never persists them — callers store via the vault (vault:// refs only).
import { randomBytes, createHash } from "node:crypto";
import { containsSecret } from "../../security/src/redact.ts";

export const OAUTH_MAX_RESPONSE_BYTES = 256 * 1024;
export const OAUTH_DEFAULT_TIMEOUT_MS = 10_000;

export type OAuthErrorCode =
  | "ENDPOINT_DENIED"
  | "DISCOVERY_FAILED"
  | "INVALID_METADATA"
  | "TOKEN_FAILED"
  | "STATE_MISMATCH"
  | "TIMEOUT"
  | "VALIDATION";

export class OAuthError extends Error {
  readonly code: OAuthErrorCode;
  constructor(code: OAuthErrorCode, message: string) {
    super(message);
    this.name = "OAuthError";
    this.code = code;
  }
}

export interface OAuthClientConfig {
  readonly clientId: string;
  /** Authorization-server issuer (https, or loopback http for dev). Optional when
   *  the protected resource publishes its own metadata. */
  readonly issuer?: string;
  readonly scopes?: readonly string[];
  /** RFC 8707 resource indicator (default: the MCP server url). */
  readonly resource?: string;
}

export interface AuthorizationServerMetadata {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly registrationEndpoint?: string;
  readonly revocationEndpoint?: string;
}

export interface TokenSet {
  readonly accessToken: string;
  readonly tokenType: "Bearer";
  readonly expiresInSec?: number;
  readonly refreshToken?: string;
  readonly scope?: string;
}

export interface OAuthDeps {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

/** OAuth endpoint posture: https everywhere; http only on loopback (dev/test). */
export function assertOAuthEndpoint(url: string, what: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new OAuthError("ENDPOINT_DENIED", `${what}: malformed url`);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new OAuthError("ENDPOINT_DENIED", `${what}: credentials in url denied`);
  }
  if (parsed.protocol === "https:") return parsed;
  if (parsed.protocol === "http:") {
    const host = parsed.hostname.toLowerCase();
    if (host === "127.0.0.1" || host === "::1" || host === "localhost" || /^127\./.test(host)) return parsed;
    throw new OAuthError("ENDPOINT_DENIED", `${what}: http allowed loopback-only (OAuth requires HTTPS)`);
  }
  throw new OAuthError("ENDPOINT_DENIED", `${what}: scheme denied: ${parsed.protocol}`);
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function generatePkcePair(): { verifier: string; challenge: string; method: "S256" } {
  const verifier = base64url(randomBytes(48)); // 64 chars (43..128 per RFC 7636)
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return Object.freeze({ verifier, challenge, method: "S256" });
}

export function generateState(): string {
  return base64url(randomBytes(32));
}

/** Bounded, timeout'd, no-redirect JSON GET/POST helper (fail closed lanes). */
async function jsonCall(
  url: string,
  init: { method: "GET" | "POST"; body?: string; contentType?: string },
  deps: OAuthDeps,
  what: string,
): Promise<Record<string, unknown>> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? OAUTH_DEFAULT_TIMEOUT_MS;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: init.method,
      redirect: "error",
      signal: ac.signal,
      headers: {
        accept: "application/json",
        ...(init.body !== undefined ? { "content-type": init.contentType ?? "application/json" } : {}),
      },
      ...(init.body !== undefined ? { body: init.body } : {}),
    });
    const raw = await res.arrayBuffer();
    if (raw.byteLength > OAUTH_MAX_RESPONSE_BYTES) {
      throw new OAuthError("INVALID_METADATA", `${what}: response byte cap exceeded (>${OAUTH_MAX_RESPONSE_BYTES})`);
    }
    let doc: unknown;
    try {
      doc = JSON.parse(Buffer.from(raw).toString("utf8"));
    } catch {
      throw new OAuthError(init.method === "GET" ? "INVALID_METADATA" : "TOKEN_FAILED", `${what}: response was not JSON`);
    }
    if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
      throw new OAuthError(init.method === "GET" ? "INVALID_METADATA" : "TOKEN_FAILED", `${what}: response was not a JSON object`);
    }
    return Object.freeze({ ...(doc as Record<string, unknown>), __httpStatus: res.status });
  } catch (err) {
    if (err instanceof OAuthError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new OAuthError("TIMEOUT", `${what}: timeout>${deps.timeoutMs ?? OAUTH_DEFAULT_TIMEOUT_MS}ms`);
    }
    throw new OAuthError("DISCOVERY_FAILED", `${what}: transport error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(t);
  }
}

/** RFC 8414 metadata discovery (well-known suffix on the issuer origin+path). */
export async function discoverAuthorizationServer(issuer: string, deps: OAuthDeps = {}): Promise<AuthorizationServerMetadata> {
  const base = assertOAuthEndpoint(issuer, "authorization-server issuer");
  const wellKnown = new URL(base.toString());
  wellKnown.pathname = (wellKnown.pathname.endsWith("/") ? wellKnown.pathname.slice(0, -1) : wellKnown.pathname) +
    "/.well-known/oauth-authorization-server";
  wellKnown.search = "";
  wellKnown.hash = "";
  const doc = await jsonCall(wellKnown.toString(), { method: "GET" }, deps, "AS metadata discovery");
  const auth = doc["authorization_endpoint"];
  const token = doc["token_endpoint"];
  if (typeof auth !== "string" || typeof token !== "string") {
    throw new OAuthError("INVALID_METADATA", "AS metadata missing authorization_endpoint/token_endpoint");
  }
  const authUrl = assertOAuthEndpoint(auth, "authorization_endpoint");
  const tokenUrl = assertOAuthEndpoint(token, "token_endpoint");
  const registration = doc["registration_endpoint"];
  const revocation = doc["revocation_endpoint"];
  return Object.freeze({
    issuer: typeof doc["issuer"] === "string" ? doc["issuer"] : base.toString(),
    authorizationEndpoint: authUrl.toString(),
    tokenEndpoint: tokenUrl.toString(),
    ...(typeof registration === "string" ? { registrationEndpoint: assertOAuthEndpoint(registration, "registration_endpoint").toString() } : {}),
    ...(typeof revocation === "string" ? { revocationEndpoint: assertOAuthEndpoint(revocation, "revocation_endpoint").toString() } : {}),
  });
}

/** RFC 9728 protected-resource metadata → candidate authorization servers. */
export async function discoverProtectedResource(resourceUrl: string, deps: OAuthDeps = {}): Promise<readonly string[]> {
  const base = assertOAuthEndpoint(resourceUrl, "protected resource");
  const wellKnown = new URL(base.toString());
  wellKnown.pathname = "/.well-known/oauth-protected-resource";
  wellKnown.search = "";
  wellKnown.hash = "";
  const doc = await jsonCall(wellKnown.toString(), { method: "GET" }, deps, "protected-resource discovery");
  const servers = doc["authorization_servers"];
  if (!Array.isArray(servers) || servers.some((s) => typeof s !== "string")) {
    throw new OAuthError("INVALID_METADATA", "protected-resource metadata missing authorization_servers[]");
  }
  for (const s of servers as readonly string[]) assertOAuthEndpoint(s, "authorization_servers entry");
  return Object.freeze([...(servers as readonly string[])]);
}

export interface AuthorizeRequest {
  readonly meta: AuthorizationServerMetadata;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly codeChallenge: string;
  readonly scopes?: readonly string[];
  readonly resource?: string;
}

/** Authorization-code + PKCE authorize URL. Pure; the operator opens it. */
export function buildAuthorizeUrl(req: AuthorizeRequest): string {
  for (const [name, v] of Object.entries({ clientId: req.clientId, state: req.state, codeChallenge: req.codeChallenge })) {
    if (typeof v !== "string" || v.length < 8 || v.length > 256 || v.includes("\u0000")) {
      throw new OAuthError("VALIDATION", `${name} must be 8..256 chars, NUL-free`);
    }
  }
  const url = assertOAuthEndpoint(req.meta.authorizationEndpoint, "authorization_endpoint");
  const q = url.searchParams;
  q.set("response_type", "code");
  q.set("client_id", req.clientId);
  q.set("redirect_uri", req.redirectUri);
  q.set("state", req.state);
  q.set("code_challenge", req.codeChallenge);
  q.set("code_challenge_method", "S256");
  if (req.scopes !== undefined && req.scopes.length > 0) q.set("scope", req.scopes.join(" "));
  if (req.resource !== undefined) q.set("resource", req.resource);
  return url.toString();
}

function parseToken(doc: Record<string, unknown>, what: string): TokenSet {
  const status = Number(doc["__httpStatus"]);
  const errCode = doc["error"];
  if (typeof errCode === "string") {
    const desc = typeof doc["error_description"] === "string" ? doc["error_description"] : "";
    throw new OAuthError("TOKEN_FAILED", `${what}: ${errCode}${desc !== "" ? ` — ${desc}` : ""}${Number.isFinite(status) ? ` (http ${status})` : ""}`);
  }
  const access = doc["access_token"];
  const type = doc["token_type"];
  if (typeof access !== "string" || access.length < 8) {
    throw new OAuthError("TOKEN_FAILED", `${what}: no access_token in response`);
  }
  if (typeof type !== "string" || type.toLowerCase() !== "bearer") {
    throw new OAuthError("TOKEN_FAILED", `${what}: token_type must be Bearer (got ${typeof type === "string" ? type : typeof type})`);
  }
  const expires = doc["expires_in"];
  const refresh = doc["refresh_token"];
  const scope = doc["scope"];
  return Object.freeze({
    accessToken: access,
    tokenType: "Bearer",
    ...(typeof expires === "number" && Number.isFinite(expires) && expires > 0 ? { expiresInSec: Math.floor(expires) } : {}),
    ...(typeof refresh === "string" && refresh.length >= 8 ? { refreshToken: refresh } : {}),
    ...(typeof scope === "string" ? { scope } : {}),
  });
}

/** code+verifier → tokens. Form-encoded per RFC 6749 §4.1.3 (never query/body-JSON). */
export async function exchangeAuthorizationCode(
  tokenEndpoint: string,
  args: { clientId: string; code: string; redirectUri: string; codeVerifier: string; resource?: string },
  deps: OAuthDeps = {},
): Promise<TokenSet> {
  assertOAuthEndpoint(tokenEndpoint, "token_endpoint");
  for (const [name, v] of Object.entries({ code: args.code, codeVerifier: args.codeVerifier, clientId: args.clientId })) {
    if (typeof v !== "string" || v === "" || v.includes("\u0000")) {
      throw new OAuthError("VALIDATION", `${name} required, NUL-free`);
    }
  }
  if (containsSecret(args.clientId)) throw new OAuthError("VALIDATION", "clientId looks like a secret (public clients use non-secret ids)");
  const quit = new URLSearchParams();
  quit.set("grant_type", "authorization_code");
  quit.set("code", args.code);
  quit.set("redirect_uri", args.redirectUri);
  quit.set("client_id", args.clientId);
  quit.set("code_verifier", args.codeVerifier);
  if (args.resource !== undefined) quit.set("resource", args.resource);
  const doc = await jsonCall(tokenEndpoint, { method: "POST", body: quit.toString(), contentType: "application/x-www-form-urlencoded" }, deps, "token exchange");
  return parseToken(doc, "token exchange");
}

export async function refreshAccessToken(
  tokenEndpoint: string,
  args: { clientId: string; refreshToken: string; resource?: string; scopes?: readonly string[] },
  deps: OAuthDeps = {},
): Promise<TokenSet> {
  assertOAuthEndpoint(tokenEndpoint, "token_endpoint");
  if (typeof args.refreshToken !== "string" || args.refreshToken.length < 8) {
    throw new OAuthError("VALIDATION", "refreshToken required");
  }
  const quit = new URLSearchParams();
  quit.set("grant_type", "refresh_token");
  quit.set("refresh_token", args.refreshToken);
  quit.set("client_id", args.clientId);
  if (args.resource !== undefined) quit.set("resource", args.resource);
  if (args.scopes !== undefined && args.scopes.length > 0) quit.set("scope", args.scopes.join(" "));
  const doc = await jsonCall(tokenEndpoint, { method: "POST", body: quit.toString(), contentType: "application/x-www-form-urlencoded" }, deps, "token refresh");
  return parseToken(doc, "token refresh");
}

/** Vault ref conventions — one place, documented; values only via the vault. */
export const oauthRefs = Object.freeze({
  pkce: (serverId: string) => `vault://mcp/${serverId}/oauth/pkce`,
  state: (serverId: string) => `vault://mcp/${serverId}/oauth/state`,
  accessToken: (serverId: string) => `vault://mcp/${serverId}/oauth/access-token`,
  refreshToken: (serverId: string) => `vault://mcp/${serverId}/oauth/refresh-token`,
});
