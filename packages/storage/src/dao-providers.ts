// Provider/model/credential DAOs — Plan §11–13. Same structural rules as dao.ts:
// parameterized statements only; credential rows store vault:// REFERENCES — a value
// cursor never exists at this layer (T5); provider config blobs are operator JSON.
import { randomUUID } from "node:crypto";
import type { SqliteDb } from "./migrate.ts";
import type { DataClassification } from "../../core/src/index.ts";

export const MODEL_STATUSES: readonly string[] = Object.freeze([
  "available",
  "degraded",
  "unavailable",
  "unverified",
]);

/** Conservative declared default until capability probes verify (P2.5). */
export const DEFAULT_MODEL_CONTEXT_WINDOW = 32_000;

const CLASSIFICATIONS = new Set(["public", "internal", "confidential", "restricted"]);

function requireClassification(v: string): DataClassification {
  if (!CLASSIFICATIONS.has(v)) throw new Error(`invalid data classification: ${v}`);
  return v as DataClassification;
}

function requireNonEmpty(v: string, field: string): string {
  if (typeof v !== "string" || v.trim() === "") throw new Error(`${field} required`);
  return v;
}

export interface ProviderRow {
  readonly id: string;
  readonly name: string;
  readonly protocol: string;
  readonly baseUrl: string;
  readonly maxClassification: DataClassification;
  readonly enabled: boolean;
  readonly configJson: string;
  readonly createdAt: string;
}

export interface ProviderUpsert {
  readonly id?: string;
  readonly name: string;
  readonly protocol: string;
  readonly baseUrl: string;
  readonly maxClassification?: DataClassification;
  readonly configJson?: string;
}

function toProviderRow(r: Record<string, unknown>): ProviderRow {
  return {
    id: String(r["id"]),
    name: String(r["name"]),
    protocol: String(r["protocol"]),
    baseUrl: String(r["base_url"]),
    maxClassification: requireClassification(String(r["max_classification"])),
    enabled: Number(r["enabled"]) === 1,
    configJson: String(r["config_json"] ?? "{}"),
    createdAt: String(r["created_at"]),
  };
}

export class ProvidersDao {
  private db: SqliteDb;
  constructor(db: SqliteDb) {
    this.db = db;
  }

  /** Insert or update by id. Returns the (possibly new) provider id. */
  upsert(input: ProviderUpsert): string {
    const id = input.id ?? randomUUID();
    requireNonEmpty(input.name, "provider name");
    requireNonEmpty(input.baseUrl, "provider baseUrl");
    requireNonEmpty(input.protocol, "provider protocol");
    const max = requireClassification(input.maxClassification ?? "internal");
    const config = input.configJson ?? "{}";
    // operator config must be parseable JSON; rejected config never reaches the DB
    JSON.parse(config);
    this.db
      .prepare(
        `INSERT INTO providers (id, name, protocol, base_url, max_classification, config_json)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, protocol = excluded.protocol, base_url = excluded.base_url,
           max_classification = excluded.max_classification, config_json = excluded.config_json`,
      )
      .run(id, input.name, input.protocol, input.baseUrl, max, config);
    return id;
  }

  get(id: string): ProviderRow | undefined {
    const row = this.db.prepare("SELECT * FROM providers WHERE id = ?").get(id);
    return row === undefined ? undefined : toProviderRow(row);
  }

  list(opts: { readonly enabledOnly?: boolean } = {}): readonly ProviderRow[] {
    const rows = opts.enabledOnly
      ? this.db.prepare("SELECT * FROM providers WHERE enabled = 1 ORDER BY name").all()
      : this.db.prepare("SELECT * FROM providers ORDER BY name").all();
    return Object.freeze(rows.map(toProviderRow));
  }

  setEnabled(id: string, enabled: boolean): void {
    const res = this.db.prepare("UPDATE providers SET enabled = ? WHERE id = ?").run(
      enabled ? 1 : 0,
      id,
    );
    if (Number((res as { changes?: unknown }).changes ?? 1) === 0) {
      throw new Error(`unknown provider: ${id}`);
    }
  }

  /** Deletes the provider; credentials + models cascade (FK ON DELETE CASCADE). */
  remove(id: string): void {
    this.db.prepare("DELETE FROM providers WHERE id = ?").run(id);
  }
}

export interface CredentialRow {
  readonly providerId: string;
  readonly vaultRef: string;
  readonly last4: string;
  readonly updatedAt: string;
}

/** Vault-reference rows only. This class NEVER touches a secret value. */
export class ProviderCredentialsDao {
  private db: SqliteDb;
  constructor(db: SqliteDb) {
    this.db = db;
  }

  set(providerId: string, vaultRef: string, last4 = "••••"): void {
    if (!vaultRef.startsWith("vault://")) {
      throw new Error("credential ref must be a vault:// reference, never a value");
    }
    this.db
      .prepare(
        `INSERT INTO provider_credentials (provider_id, vault_ref, last4, updated_at)
         VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT(provider_id) DO UPDATE SET
           vault_ref = excluded.vault_ref, last4 = excluded.last4,
           updated_at = excluded.updated_at`,
      )
      .run(providerId, vaultRef, last4.slice(-4));
  }

  get(providerId: string): CredentialRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM provider_credentials WHERE provider_id = ?")
      .get(providerId);
    if (row === undefined) return undefined;
    return {
      providerId: String(row["provider_id"]),
      vaultRef: String(row["vault_ref"]),
      last4: String(row["last4"]),
      updatedAt: String(row["updated_at"]),
    };
  }

  remove(providerId: string): void {
    this.db.prepare("DELETE FROM provider_credentials WHERE provider_id = ?").run(providerId);
  }
}

export interface ModelRow {
  readonly id: string; // natural id: "<providerId>:<modelName>"
  readonly providerId: string;
  readonly displayName: string;
  readonly capabilitiesJson: string;
  readonly verified: boolean;
  readonly contextWindow: number;
  readonly status: string;
  readonly updatedAt: string;
}

export interface ModelUpsert {
  readonly providerId: string;
  readonly name: string; // provider-native model id (e.g. "gpt-4.1")
  readonly displayName?: string;
  readonly capabilitiesJson?: string;
  readonly contextWindow?: number;
}

export function naturalModelId(providerId: string, name: string): string {
  return `${providerId}:${name}`;
}

function toModelRow(r: Record<string, unknown>): ModelRow {
  return {
    id: String(r["id"]),
    providerId: String(r["provider_id"]),
    displayName: String(r["display_name"]),
    capabilitiesJson: String(r["capabilities_json"]),
    verified: Number(r["verified"]) === 1,
    contextWindow: Number(r["context_window"]),
    status: String(r["status"]),
    updatedAt: String(r["updated_at"]),
  };
}

export class ModelsDao {
  private db: SqliteDb;
  constructor(db: SqliteDb) {
    this.db = db;
  }

  /** Insert-or-merge discovered models. Status/verified are preserved on re-discovery. */
  upsert(input: ModelUpsert): string {
    const id = naturalModelId(
      requireNonEmpty(input.providerId, "providerId"),
      requireNonEmpty(input.name, "model name"),
    );
    const cw = input.contextWindow ?? DEFAULT_MODEL_CONTEXT_WINDOW;
    if (!Number.isInteger(cw) || cw <= 0) throw new Error("contextWindow must be positive int");
    const caps = input.capabilitiesJson ?? "{}";
    JSON.parse(caps);
    this.db
      .prepare(
        `INSERT INTO models (id, provider_id, display_name, capabilities_json, context_window)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           display_name = excluded.display_name,
           capabilities_json = excluded.capabilities_json,
           context_window = excluded.context_window,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      )
      .run(id, input.providerId, input.displayName ?? input.name, caps, cw);
    return id;
  }

  get(id: string): ModelRow | undefined {
    const row = this.db.prepare("SELECT * FROM models WHERE id = ?").get(id);
    return row === undefined ? undefined : toModelRow(row);
  }

  listByProvider(providerId: string): readonly ModelRow[] {
    return Object.freeze(
      this.db
        .prepare("SELECT * FROM models WHERE provider_id = ? ORDER BY display_name")
        .all(providerId)
        .map(toModelRow),
    );
  }

  listAll(): readonly ModelRow[] {
    return Object.freeze(
      this.db
        .prepare("SELECT * FROM models ORDER BY provider_id, display_name")
        .all()
        .map(toModelRow),
    );
  }

  setStatus(id: string, status: string): void {
    if (!MODEL_STATUSES.includes(status)) throw new Error(`invalid model status: ${status}`);
    this.db
      .prepare(
        "UPDATE models SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
      )
      .run(status, id);
  }

  setVerified(id: string, verified: boolean): void {
    this.db
      .prepare(
        "UPDATE models SET verified = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
      )
      .run(verified ? 1 : 0, id);
  }
}
