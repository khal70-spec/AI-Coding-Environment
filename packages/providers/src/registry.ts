// Model registry services — Plan §12 (P2.5): discovery diff/merge into SQLite,
// capability verification probes, and a DB-backed ModelRegistry for CLI/orchestrator.
// Posture: provider declarations are UNTRUSTED until a probe round-trips. Status
// machine (per model): unverified →(probe pass)→ available; probe failure:
//   AUTH → unavailable (creds wrong; discovery shape irrelevant)
//   transient (RATE_LIMIT/SERVER/NETWORK) → stays unverified (provider may recover)
//   answered-but-wrong / VALIDATION → degraded (reachable but not capability-proven)
import { ModelsDao, naturalModelId } from "../../storage/src/dao-providers.ts";
import { ProviderError } from "./errors.ts";
import { redact } from "../../security/src/redact.ts";
import type { ProviderDispatcher } from "./dispatcher.ts";
import type { ProviderConfig } from "./base.ts";
import {
  validateModelRecord,
  type ModelCapability,
  type ModelRecord,
  type ModelRegistry,
  type ModelStatus,
} from "./index.ts";

const PROBE_WORD = "pong";

export interface DiscoveryReport {
  readonly providerId: string;
  readonly totalFound: number;
  readonly added: number;
  readonly updated: number;
}

/** Discover models from the provider and merge them into the models table. */
export async function discoverIntoDb(
  config: ProviderConfig,
  dispatcher: ProviderDispatcher,
  models: ModelsDao,
): Promise<DiscoveryReport> {
  const found = await dispatcher.listModels(config);
  let added = 0;
  let updated = 0;
  for (const m of found) {
    const prefix = `${config.id}:`;
    if (!m.id.startsWith(prefix)) {
      throw new ProviderError(
        "VALIDATION",
        "adapter returned a model record for the wrong provider id",
        { providerId: config.id },
      );
    }
    const nativeName = m.id.slice(prefix.length);
    const id = naturalModelId(config.id, nativeName);
    const existed = models.get(id) !== undefined;
    models.upsert({
      providerId: config.id,
      name: nativeName,
      displayName: m.displayName,
      capabilitiesJson: JSON.stringify(m.capabilities),
      contextWindow: m.contextWindow,
    });
    if (existed) updated += 1;
    else added += 1;
  }
  return Object.freeze({ providerId: config.id, totalFound: found.length, added, updated });
}

export interface ProbeReport {
  readonly modelId: string;
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly statusAfter: ModelStatus;
  /** Redacted, content-free failure note. Never the model's answer. */
  readonly detail?: string;
}

function rowToRecord(row: ReturnType<ModelsDao["get"]>): ModelRecord {
  const r = row!;
  let caps: Record<string, unknown> = {};
  try {
    caps = JSON.parse(r.capabilitiesJson) as Record<string, unknown>;
  } catch {
    caps = {};
  }
  const capabilities = Object.fromEntries(
    ([
      "text",
      "vision",
      "audio",
      "tools",
      "structured-output",
      "reasoning",
      "coding",
      "long-context",
      "streaming",
      "parallel-tools",
      "computer-use",
      "embeddings",
      "image-generation",
    ] as const).map((k) => [k, caps[k] === true]),
  ) as Record<ModelCapability, boolean>;
  return Object.freeze({
    id: r.id,
    providerId: r.providerId,
    displayName: r.displayName,
    capabilities,
    contextWindow: r.contextWindow,
    declaredCapabilitiesVerified: r.verified,
    status: r.status as ModelStatus,
  });
}

/** Round-trip probe for one model; persists status + verification. */
export async function probeModel(
  config: ProviderConfig,
  dispatcher: ProviderDispatcher,
  models: ModelsDao,
  modelId: string,
): Promise<ProbeReport> {
  const row = models.get(modelId);
  if (row === undefined || row.providerId !== config.id) {
    throw new ProviderError("VALIDATION", `unknown model for this provider: ${modelId}`, {
      providerId: config.id,
    });
  }
  const nativeName = modelId.slice(`${config.id}:`.length);
  const started = Date.now();
  try {
    const res = await dispatcher.complete(
      config,
      {
        model: nativeName,
        messages: [
          { role: "system", content: `You are a capability probe. Reply with exactly: ${PROBE_WORD}` },
          { role: "user", content: PROBE_WORD },
        ],
        maxTokens: 16,
        temperature: 0,
      },
      // probe context carries no sensitive data → public classification
      { contextClassification: "public" },
    );
    const passed = res.finishReason === "stop" && res.content.toLowerCase().includes(PROBE_WORD);
    if (passed) {
      models.setVerified(modelId, true);
      models.setStatus(modelId, "available");
      return Object.freeze({
        modelId,
        ok: true,
        latencyMs: Date.now() - started,
        statusAfter: "available" as const,
      });
    }
    models.setStatus(modelId, "degraded");
    return Object.freeze({
      modelId,
      ok: false,
      latencyMs: Date.now() - started,
      statusAfter: "degraded" as const,
      detail: `probe answered with finish=${res.finishReason} but did not round-trip the token`,
    });
  } catch (err) {
    const code = err instanceof ProviderError ? err.code : "NETWORK";
    const statusAfter: ModelStatus =
      code === "AUTH" ? "unavailable" : code === "VALIDATION" || code === "CONTEXT_LENGTH" ? "degraded" : "unverified";
    models.setStatus(modelId, statusAfter);
    return Object.freeze({
      modelId,
      ok: false,
      latencyMs: Date.now() - started,
      statusAfter,
      detail: err instanceof Error ? redact(err.message).text : "probe failed",
    });
  }
}

export async function probeAll(
  config: ProviderConfig,
  dispatcher: ProviderDispatcher,
  models: ModelsDao,
): Promise<readonly ProbeReport[]> {
  const rows = models.listByProvider(config.id);
  const out: ProbeReport[] = [];
  for (const row of rows) out.push(await probeModel(config, dispatcher, models, row.id));
  return Object.freeze(out);
}

/** DB-backed registry for the CLI + orchestrator (replaces InMemoryRegistry for reads). */
export class DbModelRegistry implements ModelRegistry {
  private models: ModelsDao;
  constructor(models: ModelsDao) {
    this.models = models;
  }

  register(model: ModelRecord): void {
    const errors = validateModelRecord(model);
    if (errors.length > 0) throw new Error(`invalid model record: ${errors.join("; ")}`);
    const prefix = `${model.providerId}:`;
    if (!model.id.startsWith(prefix)) {
      throw new Error("model id must be `${model.providerId}:${nativeName}`");
    }
    this.models.upsert({
      providerId: model.providerId,
      name: model.id.slice(prefix.length),
      displayName: model.displayName,
      capabilitiesJson: JSON.stringify(model.capabilities),
      contextWindow: model.contextWindow,
    });
    if (model.declaredCapabilitiesVerified) this.models.setVerified(model.id, true);
    this.models.setStatus(model.id, model.status);
  }

  get(id: string): ModelRecord | undefined {
    const row = this.models.get(id);
    return row === undefined ? undefined : rowToRecord(row);
  }

  list(): readonly ModelRecord[] {
    return Object.freeze(this.models.listAll().map(rowToRecord));
  }

  listByCapability(cap: ModelCapability): readonly ModelRecord[] {
    return Object.freeze(
      this.list().filter((m) => m.capabilities[cap] && m.status === "available"),
    );
  }

  setStatus(id: string, status: ModelStatus): void {
    this.models.setStatus(id, status);
  }
}
