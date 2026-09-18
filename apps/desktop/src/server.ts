// Desktop bridge server (P7.2): a LOCAL control surface over the bridge kernel.
// Hardening (Plan §28 bridge posture):
//   - /api/*   → bridge dispatch only; JSON body capped; methods POST; errors stable
//   - static    → path whitelist (no traversal), strict CSP, nosniff, no-store API
//   - origin    → browser calls are same-origin by construction (no CORS headers);
//                 Host header is validated against an explicit allowlist when set
//     BRIDGE_ALLOWED_HOSTS (comma list) — empty list = any (dev convenience only)
//   - writes    → happen through the bridge commands → engine/DAOs (audited)
import { createServer, type IncomingMessage, type Server } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { extname, join, resolve, normalize } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  openDatabase,
  ProjectsDao,
  TasksDao,
  RunsDao,
  WorkspacesDao,
  AuditDao,
  AgentRunsDao,
  TestResultsDao,
  FindingsDao,
  McpServersDao,
  SkillsDao,
} from "../../../packages/storage/src/index.ts";
import type { OpenedDatabase } from "../../../packages/storage/src/index.ts";
import { TaskEngine } from "../../../packages/orchestrator/src/index.ts";
import { buildBridge, type UiServices } from "../../../packages/ui/src/index.ts";

export const BRIDGE_MAX_BODY_BYTES = 64 * 1024;

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "web");

const MIME: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function securityHeaders(api: boolean): Record<string, string> {
  const base: Record<string, string> = {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
  };
  if (api) {
    base["cache-control"] = "no-store";
    base["content-type"] = "application/json; charset=utf-8";
  } else {
    base["content-security-policy"] =
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
    base["x-content-type-options"] = "nosniff";
  }
  return base;
}

/** First N bytes must not contain control characters other than tab/LF/CR. */
function hasControlBytes(buf: Buffer, firstN: number): boolean {
  const n = Math.min(buf.length, firstN);
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b !== undefined && b < 32 && b !== 9 && b !== 10 && b !== 13) return true;
  }
  return false;
}

function readBody(req: IncomingMessage, limit = BRIDGE_MAX_BODY_BYTES): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("BODY_TOO_LARGE"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolvePromise(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export interface BridgeServerOptions {
  readonly dbPath: string;
  readonly actor: string;
  readonly webRoot?: string;
  /** Host allowlist (preview hosts). Empty → any (local dev). */
  readonly allowedHosts?: readonly string[];
}

export interface BridgeHandle {
  readonly server: Server;
  readonly port: number;
  readonly db: OpenedDatabase;
  close(): void;
}

interface ApiRequest {
  command: string;
  args?: unknown;
}

function hostAllowed(mcHost: string | undefined, allowed: readonly string[]): boolean {
  if (allowed.length === 0) return true;
  if (mcHost === undefined) return false;
  const host = mcHost.split(":")[0]?.toLowerCase() ?? "";
  return allowed.some((a) => host === a.toLowerCase() || host.endsWith(`.${a.toLowerCase()}`));
}

export function startBridge(options: BridgeServerOptions): Promise<BridgeHandle> {
  const opened = openDatabase(options.dbPath);
  const services: UiServices = {
    actor: options.actor,
    projects: new ProjectsDao(opened.db),
    tasks: new TasksDao(opened.db),
    runs: new RunsDao(opened.db),
    workspaces: new WorkspacesDao(opened.db),
    audit: new AuditDao(opened.db),
    agentRuns: new AgentRunsDao(opened.db),
    testResults: new TestResultsDao(opened.db),
    findings: new FindingsDao(opened.db),
    mcpServers: new McpServersDao(opened.db),
    skills: new SkillsDao(opened.db),
    engine: undefined as never, // set below (needs the DAOs)
  };
  const engine = new TaskEngine({ tasks: services.tasks, runs: services.runs, audit: services.audit, testResults: services.testResults, findings: services.findings });
  const svc = Object.assign(Object.create(null) as UiServices, services, { engine });
  const bridge = buildBridge();
  const allowed = options.allowedHosts ?? [];
  const webRoot = options.webRoot ?? WEB_ROOT;

  const server = createServer(async (req, res) => {
    const api = (req.url ?? "").startsWith("/api/");
    // host gate first (everything structural; never trust-signal beyond preview hosts)
    if (!hostAllowed(req.headers.host, allowed)) {
      res.writeHead(403, securityHeaders(true)).end(JSON.stringify({ ok: false, code: "HOST_DENIED", message: "host not allowed" }));
      return;
    }

    if (api) {
      Object.entries(securityHeaders(true)).forEach(([k, v]) => res.setHeader(k, v));
      if (req.method !== "POST") {
        res.writeHead(405).end(JSON.stringify({ ok: false, code: "METHOD", message: "POST only" }));
        return;
      }
      let body: Buffer;
      try {
        body = await readBody(req);
      } catch (err) {
        // close-after-response: 413 must be DELIVERED (never a silent socket kill);
        // `connection: close` lets node drain and discard the remainder safely.
        req.removeAllListeners("data");
        req.resume();
        res.setHeader("connection", "close");
        res.writeHead(413).end(JSON.stringify({ ok: false, code: "BODY_TOO_LARGE", message: err instanceof Error ? err.message : "too large" }));
        return;
      }
      if (hasControlBytes(body, 512)) {
        res.writeHead(400).end(JSON.stringify({ ok: false, code: "BAD_JSON", message: "control characters denied" }));
        return;
      }
      let call: ApiRequest;
      try {
        call = JSON.parse(body.toString("utf8")) as ApiRequest;
      } catch {
        res.writeHead(400).end(JSON.stringify({ ok: false, code: "BAD_JSON", message: "malformed json" }));
        return;
      }
      if (typeof call.command !== "string" || call.command.length > 64) {
        res.writeHead(400).end(JSON.stringify({ ok: false, code: "BAD_JSON", message: "command string required" }));
        return;
      }
      const reply = await bridge.dispatch(svc, { command: call.command, args: call.args });
      const status = reply.ok ? 200 : reply.code === "UNKNOWN_COMMAND" ? 404 : reply.code === "BAD_ARGS" ? 400 : reply.code === "NOT_FOUND" ? 404 : 500;
      res.writeHead(status).end(JSON.stringify(reply));
      return;
    }

    // static surface (path whitelist + traversal-proof)
    Object.entries(securityHeaders(false)).forEach(([k, v]) => res.setHeader(k, v));
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "content-type": "text/plain" }).end("method");
      return;
    }
    let urlPath = (req.url ?? "/").split("?")[0] ?? "/";
    if (urlPath === "/") urlPath = "/index.html";
    if (!/^\/[A-Za-z0-9._/-]*$/.test(urlPath) || urlPath.includes("..")) {
      res.writeHead(400, { "content-type": "text/plain" }).end("bad path");
      return;
    }
    const abs = normalize(join(webRoot, urlPath.slice(1)));
    if (!abs.startsWith(webRoot) || !existsSync(abs) || !statSync(abs).isFile()) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    const mime = MIME[extname(abs)] ?? "application/octet-stream";
    const data = readFileSync(abs);
    res.writeHead(200, { "content-type": mime, "content-length": String(data.length), "cache-control": "no-cache" });
    if (req.method === "GET") res.end(data);
    else res.end();
  });

  return new Promise((resolvePromise) => {
    server.listen(0, "0.0.0.0", () => {
      const port = (server.address() as { port: number }).port;
      resolvePromise({
        server,
        port,
        db: opened,
        close() {
          try {
            server.close();
          } finally {
            opened.db.close();
          }
        },
      });
    });
  });
}

/** CLI entry: `node apps/desktop/src/server.ts` (dev/preview). */
export async function main(): Promise<void> {
  const dbPath = process.env.DB_PATH ?? ".local/app.db";
  const actor = process.env.BRIDGE_ACTOR ?? "operator";
  const allowed = (process.env.BRIDGE_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter((h) => h !== "");
  const handle = await startBridge({ dbPath, actor, allowedHosts: allowed });
  console.log(`aice desktop bridge (preview): http://0.0.0.0:${handle.port} (db: ${dbPath}, actor: ${actor})`);
  const stop = () => {
    handle.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (process.argv[1] !== undefined && process.argv[1].endsWith("server.ts")) {
  void main();
}
