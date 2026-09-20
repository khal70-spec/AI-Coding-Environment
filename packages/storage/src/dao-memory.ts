// Memory DAOs (Plan §25, migration 006). Rows are exact-scope records: the UNIQUE
// tuple (scope, project_id, task_id, model_id, key) is total ('' defaults), and every
// query here is scope+id-exact — there is deliberately NO cross-scope/cross-project
// read (T20 leak-proofing by construction). All statements parameterized.
import { randomUUID } from "node:crypto";
import type { SqliteDb } from "./migrate.ts";

export type MemoryScope = "global" | "project" | "task" | "model" | "scratchpad";
export const MEMORY_SCOPES: readonly MemoryScope[] = Object.freeze([
  "global",
  "project",
  "task",
  "model",
  "scratchpad",
]);

export interface MemoryIds {
  readonly projectId?: string;
  readonly taskId?: string;
  readonly modelId?: string;
}

export interface MemoryEntryRow {
  readonly id: string;
  readonly scope: MemoryScope;
  readonly projectId: string;
  readonly taskId: string;
  readonly modelId: string;
  readonly key: string;
  readonly valueJson: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string | null;
}

export interface MemoryRetentionRow {
  readonly scope: MemoryScope;
  readonly retentionDays: number;
  readonly maxEntries: number;
}

function newId(): string {
  return randomUUID();
}
function asString(v: unknown): string {
  return typeof v === "string" ? v : String(v);
}
function asNullableString(v: unknown): string | null {
  return v === null || v === undefined ? null : asString(v);
}
function mapEntry(r: Record<string, unknown>): MemoryEntryRow {
  return Object.freeze({
    id: asString(r["id"]),
    scope: asString(r["scope"]) as MemoryScope,
    projectId: asString(r["project_id"]),
    taskId: asString(r["task_id"]),
    modelId: asString(r["model_id"]),
    key: asString(r["key"]),
    valueJson: asString(r["value_json"]),
    createdBy: asString(r["created_by"]),
    createdAt: asString(r["created_at"]),
    updatedAt: asString(r["updated_at"]),
    expiresAt: asNullableString(r["expires_at"]),
  });
}

export class MemoryEntriesDao {
  private readonly db: SqliteDb;
  constructor(db: SqliteDb) {
    this.db = db;
  }

  /** Deterministic upsert on the natural UNIQUE tuple. Returns row id. */
  upsert(input: {
    scope: MemoryScope;
    key: string;
    valueJson: string;
    createdBy: string;
    projectId?: string;
    taskId?: string;
    modelId?: string;
    expiresAt?: string | null;
    id?: string;
  }): string {
    const id = input.id ?? newId();
    this.db
      .prepare(
        "INSERT INTO memory_entries (id, scope, project_id, task_id, model_id, key, value_json, created_by, expires_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(scope, project_id, task_id, model_id, key) DO UPDATE SET " +
          "value_json=excluded.value_json, expires_at=excluded.expires_at, " +
          "updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
      )
      .run(
        id,
        input.scope,
        input.projectId ?? "",
        input.taskId ?? "",
        input.modelId ?? "",
        input.key,
        input.valueJson,
        input.createdBy,
        input.expiresAt ?? null,
      );
    return id;
  }

  get(scope: MemoryScope, ids: MemoryIds, key: string): MemoryEntryRow | undefined {
    const r = this.db
      .prepare("SELECT * FROM memory_entries WHERE scope = ? AND project_id = ? AND task_id = ? AND model_id = ? AND key = ?")
      .get(scope, ids.projectId ?? "", ids.taskId ?? "", ids.modelId ?? "", key) as Record<string, unknown> | undefined;
    return r === undefined ? undefined : mapEntry(r);
  }

  /** Scope+id-exact listing (key-prefixed optional). Never unions across ids. */
  list(scope: MemoryScope, ids: MemoryIds, opts: { prefix?: string; limit?: number } = {}): readonly MemoryEntryRow[] {
    const limit = Math.min(Math.max(opts.limit ?? 500, 1), 1000);
    const rows = (
      opts.prefix === undefined
        ? (this.db
            .prepare("SELECT * FROM memory_entries WHERE scope = ? AND project_id = ? AND task_id = ? AND model_id = ? ORDER BY key LIMIT ?")
            .all(scope, ids.projectId ?? "", ids.taskId ?? "", ids.modelId ?? "", limit) as unknown as Record<string, unknown>[])
        : (this.db
            .prepare(
              "SELECT * FROM memory_entries WHERE scope = ? AND project_id = ? AND task_id = ? AND model_id = ? AND key LIKE ? ESCAPE '\\' ORDER BY key LIMIT ?",
            )
            .all(scope, ids.projectId ?? "", ids.taskId ?? "", ids.modelId ?? "", escapeLike(opts.prefix) + "%", limit) as unknown as Record<string, unknown>[])
    );
    return Object.freeze(rows.map(mapEntry));
  }

  /** id-exact delete. Returns true when a row was removed. */
  remove(scope: MemoryScope, ids: MemoryIds, key: string): boolean {
    const info = this.db
      .prepare("DELETE FROM memory_entries WHERE scope = ? AND project_id = ? AND task_id = ? AND model_id = ? AND key = ?")
      .run(scope, ids.projectId ?? "", ids.taskId ?? "", ids.modelId ?? "", key) as unknown as { changes: number };
    return Number(info.changes) > 0;
  }

  /** Remove every entry inside one exact scope+id partition. Returns count removed. */
  purgePartition(scope: MemoryScope, ids: MemoryIds): number {
    const info = this.db
      .prepare("DELETE FROM memory_entries WHERE scope = ? AND project_id = ? AND task_id = ? AND model_id = ?")
      .run(scope, ids.projectId ?? "", ids.taskId ?? "", ids.modelId ?? "") as unknown as { changes: number };
    return Number(info.changes);
  }

  /** Retention lanes (sweep operates globally, one partition class at a time). */
  deleteExpired(nowIso: string): number {
    const info = this.db
      .prepare("DELETE FROM memory_entries WHERE expires_at IS NOT NULL AND expires_at <= ?")
      .run(nowIso) as unknown as { changes: number };
    return Number(info.changes);
  }
  deleteOlderThan(scope: MemoryScope, cutoffIso: string): number {
    const info = this.db
      .prepare("DELETE FROM memory_entries WHERE scope = ? AND updated_at < ?")
      .run(scope, cutoffIso) as unknown as { changes: number };
    return Number(info.changes);
  }
  /** Oldest-updated row ids beyond the scope's max_entries budget (exact per scope). */
  idsBeyondMax(scope: MemoryScope, maxEntries: number): readonly string[] {
    const rows = this.db
      .prepare(
        "SELECT id FROM memory_entries WHERE scope = ? ORDER BY updated_at DESC, id DESC LIMIT -1 OFFSET ?",
      )
      .all(scope, maxEntries) as unknown as Record<string, unknown>[];
    return Object.freeze(rows.map((r) => asString(r["id"])));
  }
  deleteById(id: string): boolean {
    const info = this.db.prepare("DELETE FROM memory_entries WHERE id = ?").run(id) as unknown as { changes: number };
    return Number(info.changes) > 0;
  }
}

/** LIKE-wildcard escape for operator-supplied prefixes (no pattern injection). */
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export class MemoryRetentionDao {
  private readonly db: SqliteDb;
  constructor(db: SqliteDb) {
    this.db = db;
  }
  get(scope: MemoryScope): MemoryRetentionRow | undefined {
    const r = this.db.prepare("SELECT * FROM memory_retention WHERE scope = ?").get(scope) as
      | Record<string, unknown>
      | undefined;
    return r === undefined
      ? undefined
      : Object.freeze({
          scope: asString(r["scope"]) as MemoryScope,
          retentionDays: Number(r["retention_days"]),
          maxEntries: Number(r["max_entries"]),
        });
  }
  upsert(scope: MemoryScope, retentionDays: number, maxEntries: number): void {
    this.db
      .prepare(
        "INSERT INTO memory_retention (scope, retention_days, max_entries) VALUES (?, ?, ?) " +
          "ON CONFLICT(scope) DO UPDATE SET retention_days=excluded.retention_days, max_entries=excluded.max_entries",
      )
      .run(scope, retentionDays, maxEntries);
  }
  list(): readonly MemoryRetentionRow[] {
    const rows = this.db.prepare("SELECT * FROM memory_retention ORDER BY scope").all() as unknown as Record<
      string,
      unknown
    >[];
    return Object.freeze(
      rows.map((r) =>
        Object.freeze({
          scope: asString(r["scope"]) as MemoryScope,
          retentionDays: Number(r["retention_days"]),
          maxEntries: Number(r["max_entries"]),
        }),
      ),
    );
  }
  /** Idempotent defaults (Plan §25 starting posture; operator-tunable after). */
  seedDefaults(): void {
    for (const d of DEFAULT_RETENTION) this.upsertIfAbsent(d.scope, d.retentionDays, d.maxEntries);
  }
  private upsertIfAbsent(scope: MemoryScope, retentionDays: number, maxEntries: number): void {
    this.db
      .prepare("INSERT OR IGNORE INTO memory_retention (scope, retention_days, max_entries) VALUES (?, ?, ?)")
      .run(scope, retentionDays, maxEntries);
  }
}

export const DEFAULT_RETENTION: readonly MemoryRetentionRow[] = Object.freeze([
  Object.freeze({ scope: "global" as const, retentionDays: 0, maxEntries: 1000 }),
  Object.freeze({ scope: "project" as const, retentionDays: 0, maxEntries: 500 }),
  Object.freeze({ scope: "task" as const, retentionDays: 90, maxEntries: 500 }),
  Object.freeze({ scope: "model" as const, retentionDays: 180, maxEntries: 500 }),
  Object.freeze({ scope: "scratchpad" as const, retentionDays: 7, maxEntries: 200 }),
]);
