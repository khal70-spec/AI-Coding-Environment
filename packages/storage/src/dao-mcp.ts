// MCP + skills registries (P6.1/P6.3). Configs carry NO secrets (credential_ref
// vault:// only). Skill rows are tamper-evident (bundle digest pinned at review).
import { randomUUID } from "node:crypto";
import type { SqliteDb } from "./migrate.ts";

export interface McpServerRow {
  readonly id: string;
  readonly name: string;
  readonly transport: string;
  readonly trust: string;
  readonly configJson: string;
  readonly enabled: boolean;
  readonly createdAt: string;
}

export interface PermissionRow {
  readonly id: string;
  readonly subject: string;
  readonly resource: string;
  readonly effect: "allow" | "deny";
  readonly createdAt: string;
}

export interface SkillRow {
  readonly id: string;
  readonly name: string;
  readonly version: string | null;
  readonly sourcePath: string;
  readonly sha256: string;
  readonly permissionsJson: string;
  readonly status: "pending_review" | "approved" | "blocked";
  readonly reviewedBy: string | null;
  readonly reviewedAt: string | null;
  readonly createdAt: string;
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

export class McpServersDao {
  private readonly db: SqliteDb;
  constructor(db: SqliteDb) {
    this.db = db;
  }
  upsert(input: { name: string; transport: string; trust?: string; configJson: string; id?: string }): string {
    const id = input.id ?? newId();
    this.db
      .prepare(
        "INSERT INTO mcp_servers (id, name, transport, trust, config_json) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET name=excluded.name, transport=excluded.transport, trust=excluded.trust, config_json=excluded.config_json",
      )
      .run(id, input.name, input.transport, input.trust ?? "low", input.configJson);
    return id;
  }
  get(id: string): McpServerRow | undefined {
    const r = this.db.prepare("SELECT * FROM mcp_servers WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r === undefined
      ? undefined
      : Object.freeze({
          id: asString(r["id"]),
          name: asString(r["name"]),
          transport: asString(r["transport"]),
          trust: asString(r["trust"]),
          configJson: asString(r["config_json"]),
          enabled: Number(r["enabled"]) === 1,
          createdAt: asString(r["created_at"]),
        });
  }
  list(): readonly McpServerRow[] {
    const rows = this.db.prepare("SELECT * FROM mcp_servers ORDER BY created_at").all() as unknown as Record<string, unknown>[];
    return Object.freeze(
      rows.map((r) => ({
        id: asString(r["id"]),
        name: asString(r["name"]),
        transport: asString(r["transport"]),
        trust: asString(r["trust"]),
        configJson: asString(r["config_json"]),
        enabled: Number(r["enabled"]) === 1,
        createdAt: asString(r["created_at"]),
      })),
    );
  }
  setEnabled(id: string, enabled: boolean): void {
    this.db.prepare("UPDATE mcp_servers SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
  }
  remove(id: string): void {
    this.db.prepare("DELETE FROM mcp_servers WHERE id = ?").run(id);
    this.db.prepare("DELETE FROM permissions WHERE subject = ?").run(`mcp:${id}`);
  }
}

export class PermissionsDao {
  private readonly db: SqliteDb;
  constructor(db: SqliteDb) {
    this.db = db;
  }
  /** Deterministic upsert by UNIQUE(subject, resource). Deny always wins reads. */
  set(subject: string, resource: string, effect: "allow" | "deny"): string {
    const existing = this.db
      .prepare("SELECT id FROM permissions WHERE subject = ? AND resource = ?")
      .get(subject, resource) as Record<string, unknown> | undefined;
    if (existing !== undefined) {
      const id = asString(existing["id"]);
      this.db.prepare("UPDATE permissions SET effect = ? WHERE id = ?").run(effect, id);
      return id;
    }
    const id = newId();
    this.db.prepare("INSERT INTO permissions (id, subject, resource, effect) VALUES (?, ?, ?, ?)").run(id, subject, resource, effect);
    return id;
  }
  listFor(subject: string): readonly PermissionRow[] {
    const rows = this.db
      .prepare("SELECT * FROM permissions WHERE subject = ? ORDER BY resource")
      .all(subject) as unknown as Record<string, unknown>[];
    return Object.freeze(
      rows.map((r) => ({
        id: asString(r["id"]),
        subject: asString(r["subject"]),
        resource: asString(r["resource"]),
        effect: asString(r["effect"]) as "allow" | "deny",
        createdAt: asString(r["created_at"]),
      })),
    );
  }
}

export class SkillsDao {
  private readonly db: SqliteDb;
  constructor(db: SqliteDb) {
    this.db = db;
  }
  register(input: {
    name: string;
    version?: string;
    sourcePath: string;
    sha256: string;
    permissionsJson: string;
    id?: string;
  }): SkillRow {
    const id = input.id ?? newId();
    this.db
      .prepare("INSERT INTO skills (id, name, version, source_path, sha256, permissions_json) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, input.name, input.version ?? null, input.sourcePath, input.sha256, input.permissionsJson);
    return this.get(id) as SkillRow;
  }
  private static map(r: Record<string, unknown>): SkillRow {
    return Object.freeze({
      id: asString(r["id"]),
      name: asString(r["name"]),
      version: asNullableString(r["version"]),
      sourcePath: asString(r["source_path"]),
      sha256: asString(r["sha256"]),
      permissionsJson: asString(r["permissions_json"]),
      status: asString(r["status"]) as SkillRow["status"],
      reviewedBy: asNullableString(r["reviewed_by"]),
      reviewedAt: asNullableString(r["reviewed_at"]),
      createdAt: asString(r["created_at"]),
    });
  }
  get(id: string): SkillRow | undefined {
    const r = this.db.prepare("SELECT * FROM skills WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r === undefined ? undefined : SkillsDao.map(r);
  }
  getByName(name: string): SkillRow | undefined {
    const r = this.db.prepare("SELECT * FROM skills WHERE name = ?").get(name) as Record<string, unknown> | undefined;
    return r === undefined ? undefined : SkillsDao.map(r);
  }
  list(): readonly SkillRow[] {
    const rows = this.db.prepare("SELECT * FROM skills ORDER BY created_at").all() as unknown as Record<string, unknown>[];
    return Object.freeze(rows.map(SkillsDao.map));
  }
  /** Human transition; digest churn is detected by the caller before invoking this. */
  setStatus(id: string, status: SkillRow["status"], reviewedBy: string): void {
    this.db
      .prepare("UPDATE skills SET status = ?, reviewed_by = ?, reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
      .run(status, reviewedBy, id);
  }
  remove(id: string): void {
    this.db.prepare("DELETE FROM skills WHERE id = ?").run(id);
    this.db.prepare("DELETE FROM permissions WHERE subject = ?").run(`skill:${id}`);
  }
}
