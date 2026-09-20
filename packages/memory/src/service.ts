// MemoryService — Plan §25. The governed lane over the memory DAOs:
// scope/id validation → secret refusal (fail closed) → size caps → audit (content-free).
// Deletion, export (contained + redacted), and retention (TTL + age + budget) included.
import { writeFileSync } from "node:fs";
import { redact, containsSecret, detectSecretKinds } from "../../security/src/redact.ts";
import { assertContainedSync } from "../../security/src/paths.ts";
import {
  MEMORY_SCOPES,
  DEFAULT_RETENTION,
  type MemoryEntriesDao,
  type MemoryEntryRow,
  type MemoryIds,
  type MemoryRetentionDao,
  type MemoryRetentionRow,
  type MemoryScope,
} from "../../storage/src/index.ts";

export type MemoryErrorCode =
  | "VALIDATION"
  | "SECRET_REFUSED"
  | "NOT_FOUND"
  | "ESCAPE"
  | "OVER_LIMIT";

export class MemoryError extends Error {
  readonly code: MemoryErrorCode;
  constructor(code: MemoryErrorCode, message: string) {
    super(message);
    this.name = "MemoryError";
    this.code = code;
  }
}

export const MEMORY_KEY_MAX = 128;
export const MEMORY_VALUE_JSON_MAX = 16_384;
export const MEMORY_EXPORT_MAX_BYTES = 1024 * 1024;
export const SCRATCHPAD_DEFAULT_TTL_HOURS = 24 * 7;

export interface MemoryRef extends MemoryIds {
  readonly scope: MemoryScope;
}

export interface MemorySetInput extends MemoryRef {
  readonly key: string;
  readonly value: unknown;
  readonly actor: string;
  /** ISO 8601 instant, or relative TTL in hours. Null/undefined = no expiry
   *  (scratchpad defaults to SCRATCHPAD_DEFAULT_TTL_HOURS). */
  readonly expiresAt?: string | null;
  readonly ttlHours?: number;
}

export interface AuditLike {
  append(e: {
    actor: string;
    action: string;
    target?: string;
    projectId?: string;
    taskId?: string;
    decision?: "allow" | "deny";
    detail?: Readonly<Record<string, unknown>>;
  }): unknown;
}

export interface MemoryServiceDeps {
  readonly entries: MemoryEntriesDao;
  readonly retention: MemoryRetentionDao;
  readonly audit?: AuditLike;
}

function isIsoInstant(s: string): boolean {
  return !Number.isNaN(Date.parse(s));
}

function validateKey(key: string): string {
  const k = key.trim();
  if (k === "") throw new MemoryError("VALIDATION", "memory key required");
  if (k.length > MEMORY_KEY_MAX) throw new MemoryError("VALIDATION", `memory key exceeds ${MEMORY_KEY_MAX} chars`);
  if (k.includes("\u0000")) throw new MemoryError("VALIDATION", "memory key must not contain NUL bytes");
  if (containsSecret(k)) throw new MemoryError("SECRET_REFUSED", `memory key looks like a secret (${detectSecretKinds(k).join(",")})`);
  return k;
}

/** Scope/id coherence — the isolation contract (T20) in one place. */
export function validateRef(ref: MemoryRef): MemoryRef {
  if (!MEMORY_SCOPES.includes(ref.scope)) {
    throw new MemoryError("VALIDATION", `unknown memory scope: ${String(ref.scope)}`);
  }
  const projectId = (ref.projectId ?? "").trim();
  const taskId = (ref.taskId ?? "").trim();
  const modelId = (ref.modelId ?? "").trim();
  const deny = (name: string): void => {
    throw new MemoryError("VALIDATION", `${name} is not allowed for scope ${ref.scope}`);
  };
  switch (ref.scope) {
    case "global":
      if (projectId !== "") deny("projectId");
      if (taskId !== "") deny("taskId");
      if (modelId !== "") deny("modelId");
      break;
    case "project":
      if (projectId === "") throw new MemoryError("VALIDATION", "project scope requires projectId");
      if (taskId !== "") deny("taskId");
      if (modelId !== "") deny("modelId");
      break;
    case "task":
      if (taskId === "") throw new MemoryError("VALIDATION", "task scope requires taskId");
      if (modelId !== "") deny("modelId");
      break;
    case "scratchpad":
      if (taskId === "") throw new MemoryError("VALIDATION", "scratchpad scope requires taskId");
      if (modelId !== "") deny("modelId");
      break;
    case "model":
      if (modelId === "") throw new MemoryError("VALIDATION", "model scope requires modelId");
      break;
  }
  for (const [name, v] of Object.entries({ projectId, taskId, modelId })) {
    if (v.length > 64 || v.includes("\u0000")) {
      throw new MemoryError("VALIDATION", `${name} must be ≤64 chars and NUL-free`);
    }
    if (containsSecret(v)) throw new MemoryError("SECRET_REFUSED", `${name} looks like a secret`);
  }
  return Object.freeze({ scope: ref.scope, projectId, taskId, modelId });
}

export class MemoryService {
  private readonly entries: MemoryEntriesDao;
  private readonly retention: MemoryRetentionDao;
  private readonly audit?: AuditLike;

  constructor(deps: MemoryServiceDeps) {
    this.entries = deps.entries;
    this.retention = deps.retention;
    this.audit = deps.audit;
    this.retention.seedDefaults();
  }

  /** Upsert. Fails closed on secret-shaped values/keys (never persisted). */
  set(input: MemorySetInput): MemoryEntryRow {
    const ref = validateRef(input);
    const key = validateKey(input.key);
    const valueJson = JSON.stringify(input.value ?? null);
    if (valueJson.length > MEMORY_VALUE_JSON_MAX) {
      throw new MemoryError("OVER_LIMIT", `memory value exceeds ${MEMORY_VALUE_JSON_MAX} serialized chars`);
    }
    if (containsSecret(valueJson)) {
      this.audit?.append({
        actor: input.actor,
        action: "memory.set",
        decision: "deny",
        projectId: ref.projectId !== "" ? ref.projectId : undefined,
        taskId: ref.taskId !== "" ? ref.taskId : undefined,
        detail: { scope: ref.scope, key, refused: detectSecretKinds(valueJson) },
      });
      throw new MemoryError("SECRET_REFUSED", `memory value looks like a secret (${detectSecretKinds(valueJson).join(",")}) — refusing to store`);
    }
    let expiresAt: string | null = null;
    if (input.expiresAt !== undefined && input.expiresAt !== null) {
      if (!isIsoInstant(input.expiresAt)) throw new MemoryError("VALIDATION", `expiresAt must be an ISO instant: ${input.expiresAt}`);
      expiresAt = new Date(input.expiresAt).toISOString();
    } else if (input.ttlHours !== undefined) {
      if (!Number.isFinite(input.ttlHours) || input.ttlHours <= 0) {
        throw new MemoryError("VALIDATION", "ttlHours must be a positive number");
      }
      expiresAt = new Date(Date.now() + input.ttlHours * 3_600_000).toISOString();
    } else if (ref.scope === "scratchpad") {
      expiresAt = new Date(Date.now() + SCRATCHPAD_DEFAULT_TTL_HOURS * 3_600_000).toISOString();
    }
    const id = this.entries.upsert({
      scope: ref.scope,
      projectId: ref.projectId,
      taskId: ref.taskId,
      modelId: ref.modelId,
      key,
      valueJson,
      createdBy: input.actor,
      expiresAt,
    });
    this.audit?.append({
      actor: input.actor,
      action: "memory.set",
      target: id,
      decision: "allow",
      projectId: ref.projectId !== "" ? ref.projectId : undefined,
      taskId: ref.taskId !== "" ? ref.taskId : undefined,
      detail: { scope: ref.scope, key, bytes: valueJson.length, expires: expiresAt !== null },
    });
    const row = this.entries.get(ref.scope, ref, key);
    if (row === undefined) throw new MemoryError("NOT_FOUND", "upsert did not round-trip");
    return row;
  }

  get(ref: MemoryRef, key: string): MemoryEntryRow | undefined {
    return this.entries.get(validateRef(ref).scope, validateRef(ref), validateKey(key));
  }

  list(ref: MemoryRef, opts: { prefix?: string; limit?: number } = {}): readonly MemoryEntryRow[] {
    const r = validateRef(ref);
    return this.entries.list(r.scope, r, opts);
  }

  delete(ref: MemoryRef, key: string, actor: string): boolean {
    const r = validateRef(ref);
    const k = validateKey(key);
    const removed = this.entries.remove(r.scope, r, k);
    this.audit?.append({
      actor,
      action: "memory.delete",
      decision: removed ? "allow" : "deny",
      projectId: r.projectId !== "" ? r.projectId : undefined,
      taskId: r.taskId !== "" ? r.taskId : undefined,
      detail: { scope: r.scope, key: k, existed: removed },
    });
    return removed;
  }

  /** Remove a whole exact partition (§25 deletion — e.g. 'wipe project X memory'). */
  purge(ref: MemoryRef, actor: string): number {
    const r = validateRef(ref);
    const removed = this.entries.purgePartition(r.scope, r);
    this.audit?.append({
      actor,
      action: "memory.purge",
      decision: "allow",
      projectId: r.projectId !== "" ? r.projectId : undefined,
      taskId: r.taskId !== "" ? r.taskId : undefined,
      detail: { scope: r.scope, removed },
    });
    return removed;
  }

  /** §25 export: contained path + redacted payload + byte cap + audit. */
  exportPartition(ref: MemoryRef, filePath: string, jailRoot: string, actor: string): { file: string; count: number; bytes: number } {
    const r = validateRef(ref);
    if (filePath.trim() === "") throw new MemoryError("VALIDATION", "export file path required");
    const jail = assertContainedSync(jailRoot, filePath);
    if (!jail.ok) throw new MemoryError("ESCAPE", `export path escapes jail: ${jail.error.message}`);
    const rows = this.entries.list(r.scope, r, { limit: 1000 });
    const payload = JSON.stringify(
      {
        format: "aice-memory-export/v1",
        scope: r.scope,
        entries: rows.map((e) => ({
          key: e.key,
          scope: e.scope,
          projectId: e.projectId,
          taskId: e.taskId,
          modelId: e.modelId,
          value: redact(e.valueJson).text,
          expiresAt: e.expiresAt,
        })),
      },
      null,
      2,
    );
    if (payload.length > MEMORY_EXPORT_MAX_BYTES) {
      throw new MemoryError("OVER_LIMIT", `export exceeds ${MEMORY_EXPORT_MAX_BYTES} bytes`);
    }
    writeFileSync(jail.path, payload + "\n", "utf8");
    this.audit?.append({
      actor,
      action: "memory.export",
      decision: "allow",
      projectId: r.projectId !== "" ? r.projectId : undefined,
      taskId: r.taskId !== "" ? r.taskId : undefined,
      detail: { scope: r.scope, count: rows.length, bytes: payload.length },
    });
    return { file: jail.path, count: rows.length, bytes: payload.length };
  }

  retentionFor(scope: MemoryScope): MemoryRetentionRow {
    return (
      this.retention.get(scope) ??
      Object.freeze(
        DEFAULT_RETENTION.find((d) => d.scope === scope) as MemoryRetentionRow,
      )
    );
  }

  retentionSet(scope: MemoryScope, retentionDays: number, maxEntries: number, actor: string): void {
    if (!MEMORY_SCOPES.includes(scope)) throw new MemoryError("VALIDATION", `unknown memory scope: ${String(scope)}`);
    if (!Number.isInteger(retentionDays) || retentionDays < 0) {
      throw new MemoryError("VALIDATION", "retentionDays must be an integer ≥ 0 (0 = keep forever)");
    }
    if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 100_000) {
      throw new MemoryError("VALIDATION", "maxEntries must be an integer 1..100000");
    }
    this.retention.upsert(scope, retentionDays, maxEntries);
    this.audit?.append({ actor, action: "memory.retention", decision: "allow", detail: { scope, retentionDays, maxEntries } });
  }

  /** §25 retention: expired rows → age cutoff → per-scope budget trim. */
  sweep(actor: string, nowIso?: string): Readonly<Record<string, number>> {
    const now = nowIso ?? new Date().toISOString();
    if (!isIsoInstant(now)) throw new MemoryError("VALIDATION", `sweep clock must be an ISO instant: ${now}`);
    const totals: Record<string, number> = {};
    const expired = this.entries.deleteExpired(now);
    if (expired > 0) totals["expired"] = expired;
    for (const scope of MEMORY_SCOPES) {
      const pol = this.retentionFor(scope);
      let removed = 0;
      if (pol.retentionDays > 0) {
        const cutoff = new Date(Date.parse(now) - pol.retentionDays * 86_400_000).toISOString();
        removed += this.entries.deleteOlderThan(scope, cutoff);
      }
      for (const id of this.entries.idsBeyondMax(scope, pol.maxEntries)) {
        if (this.entries.deleteById(id)) removed += 1;
      }
      if (removed > 0) {
        totals[scope] = (totals[scope] ?? 0) + removed;
        this.audit?.append({ actor, action: "memory.sweep", decision: "allow", detail: { scope, removed } });
      }
    }
    return Object.freeze(totals);
  }
}
