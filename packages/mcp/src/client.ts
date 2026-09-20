// MCP client (P6.2): JSON-RPC 2.0 over http(s) or stdio, contained hard:
//   - transport gate re-checks the endpoint at call time (not just install)
//   - byte caps, timeouts, redirect-refusal, structured lanes (never throws silently)
//   - stdio spawns argv-only (validated at install), never a shell
// Tool/schema shadowing is impossible by construction: the server never sees raw
// tool ids — every call is a JSON-RPC method with the tool as an argument string.
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { McpServerConfig } from "./index.ts";
import { assertMcpEndpoint, mcpEndpointVerdict } from "./gates.ts";

export const MCP_MAX_RESPONSE_BYTES = 512 * 1024;
export const MCP_DEFAULT_TIMEOUT_MS = 15_000;

export interface JsonRpcResponse {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: string;
  readonly lane: "http" | "stdio" | "denied";
}

export interface McpClientDeps {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  /** OAuth 2.1 remote profile: a vault-RESOLVED bearer token for this one call.
   *  Callers resolve it per call (no caching here); configs never carry tokens. */
  readonly bearerToken?: string;
}

interface JsonRpcReply {
  readonly jsonrpc?: string;
  readonly result?: unknown;
  readonly error?: { code?: number; message?: string };
  readonly id?: unknown;
}

function rpcFrame(method: string, params?: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, ...(params === undefined ? {} : { params }) });
}

/** Refuse redirects structurally: we only accept direct responses. */
async function httpRpc(url: string, body: string, opts: McpClientDeps): Promise<JsonRpcResponse> {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await doFetch(url, {
      method: "POST",
      redirect: "error",
      signal: ac.signal,
      headers: {
        "content-type": "application/json",
        ...(opts.bearerToken !== undefined && opts.bearerToken !== ""
          ? { authorization: `Bearer ${opts.bearerToken}` }
          : {}),
      },
      body,
    });
    const raw = await res.arrayBuffer();
    if (raw.byteLength > MCP_MAX_RESPONSE_BYTES) {
      return Object.freeze({
        ok: false,
        lane: "http",
        error: `response byte cap exceeded (${raw.byteLength} > ${MCP_MAX_RESPONSE_BYTES})`,
      });
    }
    let reply: JsonRpcReply;
    try {
      reply = JSON.parse(Buffer.from(raw).toString("utf8")) as JsonRpcReply;
    } catch {
      return Object.freeze({ ok: false, lane: "http", error: "response was not JSON-RPC" });
    }
    if (reply.error !== undefined) {
      return Object.freeze({ ok: false, lane: "http", error: reply.error.message ?? `rpc error ${String(reply.error.code)}` });
    }
    if (!res.ok) return Object.freeze({ ok: false, lane: "http", error: `http ${res.status}` });
    return Object.freeze({ ok: true, lane: "http", result: reply.result });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return Object.freeze({ ok: false, lane: "http", error: `timeout>${timeoutMs}ms` });
    }
    return Object.freeze({ ok: false, lane: "http", error: `transport error: ${err instanceof Error ? err.message : String(err)}` });
  } finally {
    clearTimeout(t);
  }
}

/** Line-delimited JSON-RPC frames on the child's stdio; one RPC per line, capped. */
async function stdioRpc(cfg: McpServerConfig, body: string, opts: McpClientDeps): Promise<JsonRpcResponse> {
  const argv = cfg.command as readonly string[];
  const timeoutMs = opts.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS;
  return new Promise<JsonRpcResponse>((resolve) => {
    const child = spawn(argv[0] as string, argv.slice(1), { stdio: ["pipe", "pipe", "ignore"], shell: false });
    let outBuf = "";
    let settled = false;
    const finish = (r: JsonRpcResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      resolve(r);
    };
    const t = setTimeout(() => {
      finish(Object.freeze({ ok: false, lane: "stdio", error: `timeout>${timeoutMs}ms` }));
    }, timeoutMs);
    child.on("error", (e) => {
      finish(Object.freeze({ ok: false, lane: "stdio", error: `spawn failed: ${e.message}` }));
    });
    child.stdout.on("data", (chunk: Buffer) => {
      outBuf += chunk.toString("utf8");
      if (outBuf.length > MCP_MAX_RESPONSE_BYTES) {
        finish(Object.freeze({ ok: false, lane: "stdio", error: `response byte cap exceeded (>${MCP_MAX_RESPONSE_BYTES})` }));
        return;
      }
      const nl = outBuf.indexOf("\n");
      if (nl === -1) return;
      const line = outBuf.slice(0, nl);
      let reply: JsonRpcReply;
      try {
        reply = JSON.parse(line) as JsonRpcReply;
      } catch {
        finish(Object.freeze({ ok: false, lane: "stdio", error: "stdout frame was not JSON-RPC" }));
        return;
      }
      if (reply.error !== undefined) {
        finish(Object.freeze({ ok: false, lane: "stdio", error: reply.error.message ?? `rpc error ${String(reply.error.code)}` }));
        return;
      }
      finish(Object.freeze({ ok: true, lane: "stdio", result: reply.result }));
    });
    child.on("close", () => {
      if (!settled) finish(Object.freeze({ ok: false, lane: "stdio", error: "child exited before answering" }));
    });
    child.stdin.write(body + "\n");
    child.stdin.end();
  });
}

export class McpClient {
  private readonly deps: McpClientDeps;
  constructor(deps: McpClientDeps = {}) {
    this.deps = deps;
  }

  /**
   * One JSON-RPC round trip. The ENDPOINT gate re-runs here (defense in depth —
   * decision layers above still own allow/deny for tools).
   */
  async call(cfg: McpServerConfig, method: string, params?: unknown): Promise<JsonRpcResponse> {
    const endpoint = mcpEndpointVerdict(cfg);
    if (endpoint.blocked) {
      return Object.freeze({ ok: false, lane: "denied", error: endpoint.reason });
    }
    const body = rpcFrame(method, params);
    if (cfg.transport === "stdio") return stdioRpc(cfg, body, this.deps);
    const e = assertMcpEndpoint(cfg);
    if (!e.ok) return Object.freeze({ ok: false, lane: "denied", error: e.reason });
    if (cfg.transport === "sse") {
      // SSE transport (legacy MCP): POST to the url; streaming responses not needed here.
      // We keep connect-surface minimal: one POST, same caps as http.
    }
    return httpRpc(cfg.url as string, body, this.deps);
  }
}
