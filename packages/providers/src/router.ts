// FailoverRouter — Plan §13 (P2.6): ordered candidates, classification-filtered,
// health-cached. Hop policy:
//   request-scoped failures (CLASSIFICATION_DENIED / SECRET_IN_REQUEST / VALIDATION /
//   CONTEXT_LENGTH) → STOP: identical for every candidate, no point burning the chain.
//   config-scoped failures (EGRESS_DENIED / AUTH) → mark provider's model unavailable-ish,
//   hop to the next candidate. Transient (RATE_LIMIT / SERVER / NETWORK) → mark degraded,
//   hop. Success → mark available. Every hop is audited (content-free).
import { classificationAllowed, type DataClassification } from "../../core/src/index.ts";
import { naturalModelId, type ModelsDao } from "../../storage/src/dao-providers.ts";
import { ProviderError } from "./errors.ts";
import type { ProviderConfig } from "./base.ts";
import type { ProviderDispatcher } from "./dispatcher.ts";
import type { ProviderEventSink } from "./dispatcher.ts";
import type { ChatRequest, ChatResponse, ProviderHealth } from "./index.ts";

export interface Candidate {
  readonly config: ProviderConfig;
  readonly model: string;
}

export interface RouterDeps {
  readonly dispatcher: ProviderDispatcher;
  readonly models?: ModelsDao;
  readonly audit?: ProviderEventSink;
  readonly healthTtlMs?: number;
}

export const DEFAULT_HEALTH_TTL_MS = 30_000;

const REQUEST_SCOPED: ReadonlySet<string> = new Set([
  "CLASSIFICATION_DENIED",
  "SECRET_IN_REQUEST",
  "VALIDATION",
  "CONTEXT_LENGTH",
]);

export class FailoverRouter {
  private readonly deps: RouterDeps;
  private readonly dispatcher: ProviderDispatcher;
  private readonly healthTtlMs: number;
  private readonly healthCache = new Map<string, { at: number; health: ProviderHealth }>();

  constructor(deps: RouterDeps) {
    this.deps = deps;
    this.dispatcher = deps.dispatcher;
    this.healthTtlMs = deps.healthTtlMs ?? DEFAULT_HEALTH_TTL_MS;
  }

  private emit(model: string, candidate: Candidate, outcome: string, code?: string): void {
    this.deps.audit?.({
      kind: "provider.route.hop",
      providerId: candidate.config.id,
      model,
      code: outcome === "ok" ? undefined : code ?? outcome,
      detail: outcome === "ok" ? "succeeded" : `hop ${outcome}${code ? ` (${code})` : ""}`,
    });
  }

  private mark(candidate: Candidate, status: "available" | "degraded" | "unavailable"): void {
    try {
      this.deps.models?.setStatus(naturalModelId(candidate.config.id, candidate.model), status);
    } catch {
      // status persistence is best-effort; routing must never crash on it
    }
  }

  /** Cached health probe per provider (TTL). */
  async health(config: ProviderConfig): Promise<ProviderHealth> {
    const cached = this.healthCache.get(config.id);
    if (cached !== undefined && Date.now() - cached.at < this.healthTtlMs) {
      return cached.health;
    }
    const health = await this.dispatcher.health(config);
    this.healthCache.set(config.id, { at: Date.now(), health });
    return health;
  }

  async complete(
    candidates: readonly Candidate[],
    request: ChatRequest,
    opts: { contextClassification: DataClassification; maxHops?: number },
  ): Promise<ChatResponse> {
    if (candidates.length === 0) {
      throw new ProviderError("VALIDATION", "no routed candidates for request");
    }
    const hopNotes: string[] = [];
    const maxHops = Math.min(opts.maxHops ?? candidates.length, candidates.length);
    let hops = 0;
    for (const candidate of candidates) {
      if (hops >= maxHops) break;
      const tag = `${candidate.config.id}/${candidate.model}`;
      if (!classificationAllowed(opts.contextClassification, candidate.config.maxClassification)) {
        hopNotes.push(`${tag}:CLASSIFICATION_DENIED`);
        this.emit(candidate.model, candidate, "skipped", "CLASSIFICATION_DENIED");
        continue; // not a hop budget burn — never tried
      }
      hops += 1;
      const health = await this.health(candidate.config);
      if (!health.ok) {
        this.mark(candidate, "degraded");
        hopNotes.push(`${tag}:unhealthy`);
        this.emit(candidate.model, candidate, "skipped", "UNHEALTHY");
        continue;
      }
      try {
        const res = await this.dispatcher.complete(candidate.config, request, opts);
        this.mark(candidate, "available");
        this.emit(candidate.model, candidate, "ok");
        if (hopNotes.length > 0) {
          this.deps.audit?.({
            kind: "provider.route.exhausted",
            providerId: candidate.config.id,
            model: candidate.model,
            detail: `failover succeeded after ${hops} hop(s); prior: [${hopNotes.join(", ")}]`,
          });
        }
        return res;
      } catch (err) {
        const code = err instanceof ProviderError ? err.code : "SERVER";
        if (err instanceof ProviderError && REQUEST_SCOPED.has(err.code)) {
          this.emit(candidate.model, candidate, "failed", code);
          throw err; // identical on every candidate — stop
        }
        hopNotes.push(`${tag}:${code}`);
        const status = code === "AUTH" ? "unavailable" : "degraded";
        this.mark(candidate, status);
        this.emit(candidate.model, candidate, "failed", code);
      }
    }
    this.deps.audit?.({
      kind: "provider.route.exhausted",
      providerId: candidates[0]?.config.id ?? "none",
      detail: `all candidates failed after ${hops} hop(s): [${hopNotes.join(", ")}]`,
    });
    throw new ProviderError(
      "SERVER",
      `all ${candidates.length} candidate(s) exhausted: [${hopNotes.join(", ")}]`,
    );
  }
}
