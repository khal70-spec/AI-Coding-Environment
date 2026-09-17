// @ai-coding-env/secrets — Plan §11, ADR-006.
// Handles only. Values enter via store(), leave via load() at narrow call sites
// (provider HTTPS dispatch), and are NEVER logged, embedded in prompts, or persisted
// in SQLite. `SecretValue` is branded so it cannot leak into stringly code paths.

/** Opaque reference, e.g. `vault://providers/acme/key`. */
export type SecretRef = string & { readonly __brand: "SecretRef" };
/** Opaque value — only the vault + provider dispatcher may unwrap. */
export type SecretValue = string & { readonly __brand: "SecretValue" };

export function secretRef(v: string): SecretRef {
  if (!v.startsWith("vault://")) throw new Error("secret ref must start with vault://");
  return v as SecretRef;
}

export function secretValue(v: string): SecretValue {
  if (v.length === 0) throw new Error("secret value must not be empty");
  return v as SecretValue;
}

export interface SecretMeta {
  readonly ref: SecretRef;
  /** Last 4 chars for identification in UI/audit. Never the full value. */
  readonly last4: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function last4Of(value: SecretValue): string {
  const raw: string = value;
  return raw.length <= 4 ? "••••" : raw.slice(-4);
}

export interface SecretVault {
  store(ref: SecretRef, value: SecretValue): Promise<void>;
  load(ref: SecretRef): Promise<SecretValue>;
  rotate(ref: SecretRef, value: SecretValue): Promise<void>;
  delete(ref: SecretRef): Promise<void>;
  describe(ref: SecretRef): Promise<SecretMeta>;
  has(ref: SecretRef): Promise<boolean>;
}

export class VaultError extends Error {
  readonly code: "NOT_FOUND" | "BACKEND_UNAVAILABLE" | "INVALID_REF";
  constructor(code: VaultError["code"], message: string) {
    super(message);
    this.name = "VaultError";
    this.code = code;
  }
}

/**
 * In-memory vault — TEST DOUBLE ONLY. Production uses OS keychain adapters with the
 * encrypted-vault fallback (ADR-006, Phase 2). It is a fail-closed stand-in that keeps
 * the handle-only discipline in unit tests without touching real credential stores.
 */
export class MemoryVault implements SecretVault {
  private readonly store_ = new Map<string, { value: SecretValue; createdAt: string; updatedAt: string }>();

  async store(ref: SecretRef, value: SecretValue): Promise<void> {
    const now = new Date().toISOString();
    const prev = this.store_.get(ref);
    this.store_.set(ref, { value, createdAt: prev?.createdAt ?? now, updatedAt: now });
  }

  async load(ref: SecretRef): Promise<SecretValue> {
    const hit = this.store_.get(ref);
    if (hit === undefined) throw new VaultError("NOT_FOUND", `no secret for ref`);
    return hit.value;
  }

  async rotate(ref: SecretRef, value: SecretValue): Promise<void> {
    if (!this.store_.has(ref)) throw new VaultError("NOT_FOUND", `no secret for ref`);
    await this.store(ref, value);
  }

  async delete(ref: SecretRef): Promise<void> {
    this.store_.delete(ref);
  }

  async describe(ref: SecretRef): Promise<SecretMeta> {
    const hit = this.store_.get(ref);
    if (hit === undefined) throw new VaultError("NOT_FOUND", `no secret for ref`);
    return { ref, last4: last4Of(hit.value), createdAt: hit.createdAt, updatedAt: hit.updatedAt };
  }

  async has(ref: SecretRef): Promise<boolean> {
    return this.store_.has(ref);
  }
}
