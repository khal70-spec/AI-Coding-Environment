// HTTP transport for providers — Plan §13, threats T5/T10/T11. Rules:
//   - redirect: "error" (never followed — redirect relay is a classic exfil path;
//     ADR-010). Operator pins the final URL; we fail closed otherwise.
//   - https required for remote endpoints; loopback http ONLY for
//     local-openai-compatible providers (checked per request origin).
//   - endpoints are validated by the DISPATCHER before any adapter call; urlFor()
//     additionally pins adapter paths to same-origin relative joins.
//   - response byte cap; every error message passes redact() before exposure.
import { redact } from "../../security/src/redact.ts";
import { checkEgress } from "../../security/src/ssrf.ts";
import { ProviderError } from "./errors.ts";
import type { ProviderProtocol } from "./index.ts";

export const DEFAULT_TIMEOUT_MS = 60_000;
export const HEALTH_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024; // 4 MiB

export interface TransportRequest {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
}

export interface TransportResponse {
  readonly status: number;
  readonly body: string;
}

export type Transport = (req: TransportRequest) => Promise<TransportResponse>;

const LOOPBACK_HOSTS = new Set(["localhost", "localhost.localdomain", "ip6-localhost"]);

function isLoopbackHostname(host: string): boolean {
  const h = host.toLowerCase();
  return LOOPBACK_HOSTS.has(h) || h === "127.0.0.1" || h === "::1" || h === "[::1]";
}

/**
 * Egress policy for PROVIDER endpoints (distinct from the tool egress guard in
 * security/ssrf.ts, which is default-deny): providers are operator-configured, so the
 * provider's own host:port is the allowlist entry — but private/metadata hosts
 * remain blocked for remote protocols, and http is allowed loopback-only.
 * Throws ProviderError(EGRESS_DENIED) — never returns a soft failure.
 */
export function assertProviderEndpoint(baseUrl: string, protocol: ProviderProtocol): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ProviderError("EGRESS_DENIED", "malformed provider base URL");
  }
  if (url.username !== "" || url.password !== "") {
    throw new ProviderError("EGRESS_DENIED", "credentials in provider URL denied");
  }
  if (protocol === "local-openai-compatible") {
    if (!isLoopbackHostname(url.hostname)) {
      throw new ProviderError(
        "EGRESS_DENIED",
        `local provider must target a loopback host, got: ${url.hostname}`,
      );
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new ProviderError("EGRESS_DENIED", `local provider scheme denied: ${url.protocol}`);
    }
    return url;
  }
  if (url.protocol !== "https:") {
    throw new ProviderError("EGRESS_DENIED", "remote provider endpoints must be https");
  }
  if (isLoopbackHostname(url.hostname)) {
    throw new ProviderError(
      "EGRESS_DENIED",
      "remote protocol cannot target loopback (use local-openai-compatible)",
    );
  }
  const port = url.port === "" ? 443 : Number(url.port);
  // Self-allowlist: host/port of the provider itself; private ranges still denied inside.
  const verdict = checkEgress(url.origin, [{ host: url.hostname, port }]);
  if (!verdict.allowed) {
    throw new ProviderError("EGRESS_DENIED", `provider endpoint denied: ${verdict.reason}`);
  }
  return url;
}

/** Adapter paths are relative joins against the provider base URL — never absolute. */
export function urlFor(baseUrl: string, path: string): string {
  if (/^https?:\/\//i.test(path) || path.startsWith("//")) {
    throw new ProviderError("EGRESS_DENIED", "adapter paths must be relative (same-origin rule)");
  }
  return baseUrl.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "");
}

/* eslint-disable no-irregular-whitespace */
function detailOf(body: string): string {
  const snippet = redact(body.slice(0, 400)).text.trim();
  return snippet === "" ? "" : `: ${snippet}`;
}

/** Stable HTTP failure → taxonomy mapping (status text never trusted verbatim). */
export function statusToProviderError(
  status: number,
  body: string,
  providerId?: string,
  headers?: Headers,
): ProviderError {
  const detail = detailOf(body);
  if (status === 401 || status === 403) {
    return new ProviderError("AUTH", `authentication failed (${status})${detail}`, {
      providerId,
      status,
    });
  }
  if (status === 408) {
    return new ProviderError("SERVER", `provider refused a slow request (408)`, { providerId, status });
  }
  if (status === 413) {
    return new ProviderError("CONTEXT_LENGTH", "request exceeds provider limits (413)", {
      providerId,
      status,
    });
  }
  if (status === 429) {
    const retry = headers?.get("retry-after");
    const retryAfterMs =
      retry !== null && retry !== undefined && /^\d+$/.test(retry) ? Number(retry) * 1000 : undefined;
    return new ProviderError("RATE_LIMIT", `rate limited (429)${detail}`, {
      providerId,
      status,
      retryAfterMs,
    });
  }
  if (status >= 500) {
    return new ProviderError("SERVER", `provider error (${status})${detail}`, { providerId, status });
  }
  if (status === 400 || status === 422) {
    if (/context.?length|too.?long|max(?:imum)?.?tokens|token.?limit/i.test(body)) {
      return new ProviderError("CONTEXT_LENGTH", `context window exceeded (${status})`, {
        providerId,
        status,
      });
    }
    return new ProviderError("VALIDATION", `request rejected (${status})${detail}`, {
      providerId,
      status,
    });
  }
  return new ProviderError("SERVER", `unexpected provider status (${status})`, { providerId, status });
}

export function parseProviderJson(body: string, context: string, providerId?: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new ProviderError("SERVER", `provider returned malformed JSON while ${context}`, {
      providerId,
    });
  }
}

/** Dot-path extraction for generic adapters; indexes are numeric segments. */
export function dotPath(value: unknown, path: string): unknown {
  let cur: unknown = value;
  for (const seg of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** The real transport (redirect:"error", byte-capped, timeout, redacted failures). */
export function fetchTransport(): Transport {
  return async (req) => {
    let res: Response;
    try {
      res = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        redirect: "error",
        signal: AbortSignal.timeout(req.timeoutMs),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ProviderError("NETWORK", `request failed: ${redact(msg).text}`);
    }
    // Byte cap enforced while streaming the body in — a 100 MiB body can't DoS memory.
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > req.maxResponseBytes) {
          void reader.cancel().catch(() => {});
          throw new ProviderError(
            "SERVER",
            `provider response exceeded ${req.maxResponseBytes} byte cap`,
          );
        }
        chunks.push(value);
      }
    }
    const flat = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      flat.set(c, offset);
      offset += c.byteLength;
    }
    const body = new TextDecoder().decode(flat);
    if (res.status < 200 || res.status >= 300) {
      throw statusToProviderError(res.status, body, undefined, res.headers);
    }
    return Object.freeze({ status: res.status, body });
  };
}
