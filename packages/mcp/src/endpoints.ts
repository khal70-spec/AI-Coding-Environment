// Endpoint assertion shared by install validation (index.ts) and runtime gates.
export function assertMcpEndpointShape(transport: string, url: string | undefined): { ok: true } | { ok: false; reason: string } {
  if (transport === "stdio") return { ok: true };
  if (url === undefined || url === "") return { ok: false, reason: "url required for http/sse" };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "malformed url" };
  }
  if (parsed.username !== "" || parsed.password !== "") return { ok: false, reason: "credentials in url denied" };
  if (parsed.protocol === "https:") return { ok: true };
  if (parsed.protocol === "http:") {
    const host = parsed.hostname.toLowerCase();
    const loop = host === "127.0.0.1" || host === "::1" || host === "localhost" || /^127\./.test(host);
    return loop ? { ok: true } : { ok: false, reason: "http allowed loopback-only for MCP" };
  }
  return { ok: false, reason: `scheme denied: ${parsed.protocol}` };
}
