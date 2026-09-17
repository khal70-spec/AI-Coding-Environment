// Base adapter — Plan §10/§13. Adapters are TRANSLATORS ONLY: wire shapes in,
// normalized records out. All policy (egress, classification, secret gates, budgets)
// lives in the dispatcher — an adapter cannot waive it by re-implementing requests.
// Secret discipline (T5): keys arrive as strings ONLY at header-building time via
// the injected resolver; they are never stored, logged, or placed in error text.
import type { DataClassification } from "../../core/src/index.ts";
import { redact } from "../../security/src/redact.ts";
import { ProviderError } from "./errors.ts";
import {
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_TIMEOUT_MS,
  HEALTH_TIMEOUT_MS,
  parseProviderJson,
  urlFor,
  type Transport,
} from "./http.ts";
import type {
  ChatRequest,
  ChatResponse,
  ModelRecord,
  Provider as ProviderIface,
  ProviderHealth,
  ProviderProtocol,
} from "./index.ts";

export interface ProviderConfig {
  readonly id: string;
  readonly name: string;
  readonly protocol: ProviderProtocol;
  readonly baseUrl: string;
  readonly maxClassification: DataClassification;
  /** vault:// ref resolved at dispatch time; absent = keyless (local only). */
  readonly credentialRef?: string;
  /** Adapter-specific operator config (parsed providers.config_json). */
  readonly config?: Readonly<Record<string, unknown>>;
}

export interface AdapterDeps {
  readonly transport: Transport;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  /** Narrow call site resolving a vault ref to a value; supplied by the dispatcher. */
  readonly resolveKey?: (ref: string) => Promise<string>;
}

export abstract class BaseAdapter implements ProviderIface {
  readonly id: string;
  readonly name: string;
  readonly protocol: ProviderProtocol;
  readonly baseUrl: string;
  readonly maxClassification: DataClassification;
  protected readonly credentialRef?: string;
  protected readonly config: Readonly<Record<string, unknown>>;
  protected readonly deps: AdapterDeps;

  constructor(cfg: ProviderConfig, deps: AdapterDeps) {
    this.id = cfg.id;
    this.name = cfg.name;
    this.protocol = cfg.protocol;
    this.baseUrl = cfg.baseUrl;
    this.maxClassification = cfg.maxClassification;
    this.credentialRef = cfg.credentialRef;
    this.config = cfg.config ?? Object.freeze({});
    this.deps = deps;
  }

  /** Auth headers. Default: Bearer from vault ref. Subclasses override per protocol. */
  protected async authHeaders(): Promise<Record<string, string>> {
    if (this.credentialRef === undefined) return {};
    if (this.deps.resolveKey === undefined) {
      throw new ProviderError("AUTH", "provider has credentials but no vault resolver", {
        providerId: this.id,
      });
    }
    const key = await this.deps.resolveKey(this.credentialRef);
    return { authorization: `Bearer ${key}` };
  }

  protected url(path: string): string {
    return urlFor(this.baseUrl, path);
  }

  /** Redacted GET/POST JSON helper with per-call timeout + caps. */
  protected async json(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
    timeoutMs = this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  ): Promise<unknown> {
    const res = await this.deps.transport({
      method,
      url: this.url(path),
      headers: {
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(await this.authHeaders()),
        ...extraHeaders,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs,
      maxResponseBytes: this.deps.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    });
    return parseProviderJson(res.body, `${method} ${path}`, this.id);
  }

  abstract listModels(): Promise<readonly ModelRecord[]>;
  abstract complete(request: ChatRequest): Promise<ChatResponse>;

  /** Cheap liveness probe: models list, time-boxed. Redacted on failure. */
  async health(): Promise<ProviderHealth> {
    const started = Date.now();
    try {
      await Promise.race([this.listModels(), rejectAfter(HEALTH_TIMEOUT_MS)]);
      return Object.freeze({
        ok: true,
        latencyMs: Date.now() - started,
        checkedAt: new Date().toISOString(),
      });
    } catch (err) {
      const msg = err instanceof Error ? redact(err.message).text : "unknown";
      return Object.freeze({
        ok: false,
        latencyMs: Date.now() - started,
        checkedAt: new Date().toISOString(),
        detail: msg,
      });
    }
  }
}

function rejectAfter(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    const t = setTimeout(() => {
      reject(new ProviderError("NETWORK", `health probe timed out after ${ms}ms`));
    }, ms);
    // never keep the event loop alive for a health probe
    t.unref?.();
  });
}
