// browser.fetch — Plan §24 (P3.4 stub): policy-gated, untrusted tagging, no JS
// execution, no redirect following, hard caps. The URL gate is 2-regime by design
// (same posture as ADR-010 provider endpoints):
//   * private/loopback/metadata addresses — blocked UNLESS the host is explicitly
//     present in the agent's networkAllow (operator-approved local regime);
//   * public hosts — allowed only when the policy kernel allows (networkAllow or
//     networkDefault "allow" — deny-by-default otherwise).
// Content-type allowlist (text/*, application/json); HTML is reduced to text —
// scripts/styles are STRIPPED, never executed.
import { defaultPort } from "../../security/src/ssrf.ts";
import { ToolError, type Tool } from "./runtime.ts";

const FETCH_TIMEOUT_MS = 8_000;
const MAX_BODY_BYTES = 256 * 1024;

/* ---- host classification (mirrors security/ssrf.ts policy; exported gate) ---- */

const METADATA_HOSTS = new Set([
  "metadata.google.internal", "metadata.google", "instance-data", "169.254.169.254", "fd00:ec2::254",
]);
const LOOPBACK_NAMES = new Set(["localhost", "localhost.localdomain", "ip6-localhost"]);

function parseIPv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m === null) return null;
  const parts = m.slice(1).map(Number);
  return parts.some((n) => n > 255) ? null : parts;
}

export function isPrivateOrMetadataHost(host: string): boolean {
  const clean = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (clean === "::" || clean === "::1" || clean === "0.0.0.0") return true;
  if (LOOPBACK_NAMES.has(clean) || METADATA_HOSTS.has(clean)) return true;
  const v4 = parseIPv4(clean);
  if (v4 !== null) {
    const [a, b] = v4 as [number, number];
    if (a === 127 || a === 0 || a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a >= 224) return true;
  }
  if (/^(fc00|fd00|fe80|::ffff:127|::ffff:10)/i.test(clean)) return true;
  return false;
}

export interface UrlGateVerdict {
  readonly ok: boolean;
  readonly reason: string;
  readonly url?: URL;
}

/**
 * The browser URL gate. `allowlist` is the agent's networkAllow (host strings,
 * optional "host:port"). Explicit entries unlock loopback/private targets too —
 * that is the local regime; everything else stays RFC1918-blocked.
 */
export function checkEgressSafeHost(raw: string, allowlist: readonly string[]): UrlGateVerdict {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "malformed URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `scheme denied: ${url.protocol}` };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: "credentials in URL denied" };
  }
  const host = url.hostname.toLowerCase();
  if (host === "") return { ok: false, reason: "empty host" };
  const port = url.port === "" ? defaultPort(url.protocol) : Number(url.port);
  const listed = allowlist.some((e) => {
    const parts = e.split(":");
    const eh = parts[0] ?? "";
    const ep = parts[1];
    if (eh.toLowerCase() !== host) return false;
    if (ep !== undefined && String(port) !== ep) return false;
    return true;
  });
  if (listed) return { ok: true, reason: "explicitly allowlisted", url };
  if (isPrivateOrMetadataHost(host)) {
    return { ok: false, reason: `private/loopback/metadata host not explicitly allowlisted: ${host}` };
  }
  return { ok: true, reason: "public host — policy decides", url };
}

/* ------------------------------- HTML → text ------------------------------- */

export function htmlToText(html: string): string {
  const noScripts = html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  return noScripts
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, " ")
    .trim();
}

const CONTENT_TYPES_ALLOW = [/^(text\/)/i, /^application\/(json|x-ndjson|xml)\b/i];

/* --------------------------------- the tool -------------------------------- */

export const browserFetch: Tool = {
  id: "browser.fetch",
  description:
    "Fetch one URL under the network policy (egress gate, caps, no redirects, no JS). Stub-shape worker.",
  defaultRisk: "medium",
  argsSchema: {
    url: { type: "string", required: true, maxLength: 2048 },
    timeoutMs: { type: "number" },
  },
  preflight(args, ctx) {
    const url = String(args["url"] ?? "");
    const gate = checkEgressSafeHost(url, ctx.grant.networkAllow);
    if (!gate.ok) {
      return { networkHost: gate.url?.hostname ?? "invalid.invalid", neverAllow: true, dangerous: true };
    }
    const u = gate.url as URL;
    return {
      networkHost: u.hostname.toLowerCase(),
      riskOverride: "medium",
    };
  },
  async run(args, ctx) {
    const gate = checkEgressSafeHost(String(args["url"]), ctx.grant.networkAllow);
    if (!gate.ok || gate.url === undefined) {
      throw new ToolError("POLICY_DENIED", `egress gate: ${gate.reason}`, [gate.reason]);
    }
    const url = gate.url;
    const timeoutMs = Math.min(Math.max(Number(args["timeoutMs"] ?? FETCH_TIMEOUT_MS), 1_000), 30_000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const res = await fetch(url, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { "user-agent": "aice-tools/0.4 (policy-gated fetch)", accept: "text/*, application/json" },
      });
      if (res.status >= 300 && res.status < 400) {
        throw new ToolError(
          "EXECUTION_FAILED",
          `redirect not followed (policy): ${res.status} → ${res.headers.get("location") ?? "?"}`,
        );
      }
      const ctype = res.headers.get("content-type") ?? "";
      if (!CONTENT_TYPES_ALLOW.some((re) => re.test(ctype))) {
        throw new ToolError("EXECUTION_FAILED", `content-type not allowed: ${ctype === "" ? "?" : ctype}`);
      }
      // streamed cap: stop at MAX_BODY_BYTES (+1 to detect overflow), then cancel
      let buf = Buffer.alloc(0);
      let overflow = false;
      const reader = res.body?.getReader();
      if (reader === undefined) {
        buf = Buffer.from(await res.text());
      } else {
        while (true) {
          const { done, value } = await reader.read();
          if (done === true || value === undefined) break;
          buf = buf.length < MAX_BODY_BYTES ? Buffer.concat([buf, value]) : buf;
          if (buf.length > MAX_BODY_BYTES) {
            overflow = true;
            await reader.cancel();
            break;
          }
          if (buf.length > MAX_BODY_BYTES) break;
        }
      }
      if (buf.length > MAX_BODY_BYTES) {
        overflow = true;
        buf = buf.subarray(0, MAX_BODY_BYTES);
      }
      let body = buf.toString("utf8");
      if (/^text\/html\b/i.test(ctype)) body = htmlToText(body);
      const head = [
        `browser.fetch: ${res.status} ${url.origin}${url.pathname}`,
        `content-type: ${ctype === "" ? "?" : ctype}  bytes: ${buf.length}${overflow ? " [capped]" : ""}`,
      ].join("\n");
      return {
        text: `${head}\n--- body ---\n${body.trim()}`,
        data: {
          url: url.toString(),
          status: res.status,
          contentType: ctype,
          bytes: buf.length,
          capped: overflow,
        },
      };
    } catch (err) {
      if (err instanceof ToolError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new ToolError("EXECUTION_FAILED", `fetch aborted after ${timeoutMs}ms`);
      }
      throw new ToolError("EXECUTION_FAILED", `fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
    }
  },
};

export const BROWSER_TOOLS: readonly Tool[] = Object.freeze([browserFetch]);
