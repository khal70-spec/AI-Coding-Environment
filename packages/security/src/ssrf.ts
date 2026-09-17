// SSRF / egress guards — Plan §20, threat T10. Default DENY.
export interface AllowEntry {
  readonly host: string; // exact hostname or IP
  readonly port?: number; // defaults per scheme when omitted
}

export interface EgressVerdict {
  readonly allowed: boolean;
  readonly reason: string;
}

const METADATA_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.google",
  "instance-data",
  "169.254.169.254",
  "fd00:ec2::254",
]);

const LOOPBACK_NAMES = new Set(["localhost", "localhost.localdomain", "ip6-localhost"]);

function isIPv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m === null) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((n) => n > 255)) return null;
  return parts as number[];
}

function isBlockedIP(host: string): boolean {
  const clean = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (clean === "::" || clean === "::1" || clean === "0.0.0.0") return true;
  if (LOOPBACK_NAMES.has(clean) || METADATA_HOSTS.has(clean)) return true;
  const v4 = isIPv4(clean);
  if (v4 !== null) {
    const [a, b] = v4 as [number, number, number, number];
    if (a === 127 || a === 0 || a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a >= 224) return true; // multicast/reserved
  }
  // IPv6 unique-local / link-local / loopback
  if (/^(fc00|fd00|fe80|::ffff:127|::ffff:10)/i.test(clean)) return true;
  return false;
}

export function defaultPort(scheme: string): number | null {
  if (scheme === "https:") return 443;
  if (scheme === "http:") return 80;
  return null;
}

/** Parse + validate a URL for server-side fetch. Never throws — returns verdict. */
export function checkEgress(rawUrl: string, allowlist: readonly AllowEntry[]): EgressVerdict {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: "malformed URL" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { allowed: false, reason: `scheme denied: ${url.protocol}` };
  }
  if (url.username !== "" || url.password !== "") {
    return { allowed: false, reason: "credentials in URL denied" };
  }
  const host = url.hostname.toLowerCase();
  if (host === "" || isBlockedIP(host)) {
    return { allowed: false, reason: `blocked host: ${url.hostname}` };
  }
  const port = url.port === "" ? defaultPort(url.protocol) : Number(url.port);
  const entry = allowlist.find((a) => a.host.toLowerCase() === host);
  if (entry === undefined) {
    return { allowed: false, reason: `host not on task allowlist: ${host}` };
  }
  const wantPort = entry.port ?? defaultPort(url.protocol);
  if (wantPort !== null && port !== null && port !== wantPort) {
    return { allowed: false, reason: `port ${port} not allowed for ${host}` };
  }
  return { allowed: true, reason: "allowlisted" };
}

/** Redirects must re-pass the allowlist — never followed blindly. */
export function checkRedirect(
  _from: string,
  to: string,
  allowlist: readonly AllowEntry[],
): EgressVerdict {
  const v = checkEgress(to, allowlist);
  if (!v.allowed) return { allowed: false, reason: `redirect denied: ${v.reason}` };
  return { allowed: true, reason: "redirect target allowlisted" };
}
