// Typed DAOs — Plan §26/§30, ADR-008. Parameterized statements only (never string
// interpolation of values). Rules enforced structurally:
//   - audit_events is APPEND-ONLY: AuditDao ships no update()/delete() and this file
//     contains no UPDATE/DELETE against audit_events (covered by a source-scan test).
//   - No secret values: provider credential rows store vault:// refs only.
//   - Project scoping (T20): every list query is scoped by project/task id explicitly.
import { randomUUID } from "node:crypto";
import type { SqliteDb } from "./migrate.ts";
import type { DataClassification, RiskLevel, TaskState } from "../../core/src/index.ts";

export interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly rootPath: string;
  readonly classification: DataClassification;
  readonly createdAt: string;
  readonly archivedAt: string | null;
}

export interface TaskRow {
  readonly id: string;
  readonly projectId: string;
  readonly conversationId: string | null;
  readonly title: string;
  readonly state: TaskState;
  readonly risk: RiskLevel;
  readonly classification: DataClassification;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RunRow {
  readonly id: string;
  readonly taskId: string;
  readonly agent: string;
  readonly modelId: string | null;
  readonly fromState: string;
  readonly toState: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly summary: string | null;
}

export interface WorkspaceRow {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string | null;
  readonly path: string;
  readonly branch: string;
  readonly baseSha: string;
  readonly state: "active" | "archived" | "removed";
  readonly createdAt: string;
}

export interface AuditEventRow {
  readonly id: number;
  readonly at: string;
  readonly actor: string;
  readonly action: string;
  readonly target: string | null;
  readonly projectId: string | null;
  readonly taskId: string | null;
  readonly decision: string | null;
  readonly detail: Readonly<Record<string, unknown>> | null;
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
function asNumber(v: unknown): number {
  return typeof v === "number" ? v : Number(v);
}

function mapProject(r: Record<string, unknown>): ProjectRow {
  return {
    id: asString(r["id"]),
    name: asString(r["name"]),
    rootPath: asString(r["root_path"]),
    classification: asString(r["classification"]) as DataClassification,
    createdAt: asString(r["created_at"]),
    archivedAt: asNullableString(r["archived_at"]),
  };
}
function mapTask(r: Record<string, unknown>): TaskRow {
  return {
    id: asString(r["id"]),
    projectId: asString(r["project_id"]),
    conversationId: asNullableString(r["conversation_id"]),
    title: asString(r["title"]),
    state: asString(r["state"]) as TaskState,
    risk: asString(r["risk"]) as RiskLevel,
    classification: asString(r["classification"]) as DataClassification,
    createdAt: asString(r["created_at"]),
    updatedAt: asString(r["updated_at"]),
  };
}
function mapRun(r: Record<string, unknown>): RunRow {
  return {
    id: asString(r["id"]),
    taskId: asString(r["task_id"]),
    agent: asString(r["agent"]),
    modelId: asNullableString(r["model_id"]),
    fromState: asString(r["from_state"]),
    toState: asString(r["to_state"]),
    startedAt: asString(r["started_at"]),
    endedAt: asNullableString(r["ended_at"]),
    summary: asNullableString(r["summary"]),
  };
}
function mapWorkspace(r: Record<string, unknown>): WorkspaceRow {
  return {
    id: asString(r["id"]),
    projectId: asString(r["project_id"]),
    taskId: asNullableString(r["task_id"]),
    path: asString(r["path"]),
    branch: asString(r["branch"]),
    baseSha: asString(r["base_sha"]),
    state: asString(r["state"]) as WorkspaceRow["state"],
    createdAt: asString(r["created_at"]),
  };
}
function mapAudit(r: Record<string, unknown>): AuditEventRow {
  const raw = asNullableString(r["detail_json"]);
  let detail: Readonly<Record<string, unknown>> | null = null;
  if (raw !== null) {
    try {
      detail = JSON.parse(raw) as Readonly<Record<string, unknown>>;
    } catch {
      detail = { unparseable: true };
    }
  }
  return {
    id: asNumber(r["id"]),
    at: asString(r["at"]),
    actor: asString(r["actor"]),
    action: asString(r["action"]),
    target: asNullableString(r["target"]),
    projectId: asNullableString(r["project_id"]),
    taskId: asNullableString(r["task_id"]),
    decision: asNullableString(r["decision"]),
    detail,
  };
}

export class ProjectsDao {
  private readonly db: SqliteDb;
  constructor(db: SqliteDb) {
    this.db = db;
  }
  create(input: { name: string; rootPath: string; classification?: DataClassification; id?: string }): ProjectRow {
    const id = input.id ?? newId();
    this.db
      .prepare("INSERT INTO projects (id, name, root_path, classification) VALUES (?, ?, ?, ?)")
      .run(id, input.name, input.rootPath, input.classification ?? "internal");
    return this.get(id);
  }
  get(id: string): ProjectRow {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (row === undefined) throw new Error(`project not found: ${id}`);
    return mapProject(row);
  }
  list(includeArchived = false): readonly ProjectRow[] {
    const rows = includeArchived
      ? this.db.prepare("SELECT * FROM projects ORDER BY created_at").all()
      : this.db.prepare("SELECT * FROM projects WHERE archived_at IS NULL ORDER BY created_at").all();
    return Object.freeze(rows.map(mapProject));
  }
  archive(id: string): void {
    this.db.prepare("UPDATE projects SET archived_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(id);
  }
}

export class TasksDao {
  private readonly db: SqliteDb;
  constructor(db: SqliteDb) {
    this.db = db;
  }
  create(input: {
    projectId: string;
    title: string;
    risk?: RiskLevel;
    classification?: DataClassification;
    conversationId?: string;
    id?: string;
  }): TaskRow {
    const id = input.id ?? newId();
    this.db
      .prepare("INSERT INTO tasks (id, project_id, conversation_id, title, risk, classification) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, input.projectId, input.conversationId ?? null, input.title, input.risk ?? "medium", input.classification ?? "internal");
    return this.get(id);
  }
  get(id: string): TaskRow {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (row === undefined) throw new Error(`task not found: ${id}`);
    return mapTask(row);
  }
  /** Project-scoped listing (T20: never cross-project). */
  listByProject(projectId: string): readonly TaskRow[] {
    return Object.freeze(
      this.db.prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at").all(projectId).map(mapTask),
    );
  }
  setState(id: string, state: TaskState): void {
    this.db
      .prepare("UPDATE tasks SET state = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
      .run(state, id);
  }
  countFixLoops(id: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM runs WHERE task_id = ? AND from_state = 'FIXING' AND to_state = 'IMPLEMENTING'")
      .get(id) as Record<string, unknown>;
    return asNumber(row["n"]);
  }
}

export class RunsDao {
  private readonly db: SqliteDb;
  constructor(db: SqliteDb) {
    this.db = db;
  }
  record(input: { taskId: string; agent: string; fromState: string; toState: string; modelId?: string; summary?: string; id?: string }): RunRow {
    const id = input.id ?? newId();
    this.db
      .prepare("INSERT INTO runs (id, task_id, agent, model_id, from_state, to_state, ended_at, summary) VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?)")
      .run(id, input.taskId, input.agent, input.modelId ?? null, input.fromState, input.toState, input.summary ?? null);
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Record<string, unknown>;
    return mapRun(row);
  }
  listByTask(taskId: string): readonly RunRow[] {
    return Object.freeze(
      this.db.prepare("SELECT * FROM runs WHERE task_id = ? ORDER BY started_at").all(taskId).map(mapRun),
    );
  }
}

export class WorkspacesDao {
  private readonly db: SqliteDb;
  constructor(db: SqliteDb) {
    this.db = db;
  }
  create(input: { projectId: string; taskId?: string; path: string; branch: string; baseSha: string; id?: string }): WorkspaceRow {
    const id = input.id ?? newId();
    this.db
      .prepare("INSERT INTO workspaces (id, project_id, task_id, path, branch, base_sha) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, input.projectId, input.taskId ?? null, input.path, input.branch, input.baseSha);
    return this.get(id);
  }
  get(id: string): WorkspaceRow {
    const row = this.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (row === undefined) throw new Error(`workspace not found: ${id}`);
    return mapWorkspace(row);
  }
  listByProject(projectId: string): readonly WorkspaceRow[] {
    return Object.freeze(
      this.db.prepare("SELECT * FROM workspaces WHERE project_id = ? ORDER BY created_at").all(projectId).map(mapWorkspace),
    );
  }
  setState(id: string, state: WorkspaceRow["state"]): void {
    this.db.prepare("UPDATE workspaces SET state = ? WHERE id = ?").run(state, id);
  }
}

export interface AuditAppend {
  readonly actor: string;
  readonly action: string;
  readonly target?: string;
  readonly projectId?: string;
  readonly taskId?: string;
  readonly decision?: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

/**
 * Append-only audit store (Plan §26, ADR-008). Intentionally exposes ONLY append + read:
 * there is no update, no delete, and no raw exec here. Redacted summaries/hashes belong
 * in `detail`, never secrets or full contents.
 */
export class AuditDao {
  private readonly db: SqliteDb;
  constructor(db: SqliteDb) {
    this.db = db;
  }
  append(e: AuditAppend): number {
    const info = this.db
      .prepare("INSERT INTO audit_events (actor, action, target, project_id, task_id, decision, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(
        e.actor,
        e.action,
        e.target ?? null,
        e.projectId ?? null,
        e.taskId ?? null,
        e.decision ?? null,
        e.detail === undefined ? null : JSON.stringify(e.detail),
      ) as unknown as { lastInsertRowid: number | bigint };
    return Number(info.lastInsertRowid);
  }
  listByTask(taskId: string): readonly AuditEventRow[] {
    return Object.freeze(
      this.db.prepare("SELECT * FROM audit_events WHERE task_id = ? ORDER BY id").all(taskId).map(mapAudit),
    );
  }
  listByProject(projectId: string): readonly AuditEventRow[] {
    return Object.freeze(
      this.db.prepare("SELECT * FROM audit_events WHERE project_id = ? ORDER BY id").all(projectId).map(mapAudit),
    );
  }
  latestByTaskAction(taskId: string, action: string): AuditEventRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM audit_events WHERE task_id = ? AND action = ? ORDER BY id DESC LIMIT 1")
      .get(taskId, action) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : mapAudit(row);
  }
}

export interface AgentRunRow {
  readonly id: string;
  readonly taskId: string;
  readonly phase: "investigate" | "plan" | "implement";
  readonly modelId: string | null;
  readonly status: string;
  readonly rounds: number;
  readonly toolCalls: number;
  readonly denials: number;
  readonly transcriptJson: string;
  readonly finalText: string | null;
  readonly createdAt: string;
}

function mapAgentRun(r: Record<string, unknown>): AgentRunRow {
  return {
    id: asString(r["id"]),
    taskId: asString(r["task_id"]),
    phase: asString(r["phase"]) as AgentRunRow["phase"],
    modelId: asNullableString(r["model_id"]),
    status: asString(r["status"]),
    rounds: asNumber(r["rounds"]),
    toolCalls: asNumber(r["tool_calls"]),
    denials: asNumber(r["denials"]),
    transcriptJson: asString(r["transcript_json"]),
    finalText: asNullableString(r["final_text"]),
    createdAt: asString(r["created_at"]),
  };
}

/**
 * Agent-loop session store (Plan §26, P4.5). Transcripts are untrusted model I/O:
 * stored verbatim for replay/evidence, never executed from the DB.
 */
export class AgentRunsDao {
  private readonly db: SqliteDb;
  constructor(db: SqliteDb) {
    this.db = db;
  }
  record(input: {
    taskId: string;
    phase: AgentRunRow["phase"];
    modelId?: string;
    status: string;
    rounds: number;
    toolCalls: number;
    denials: number;
    transcriptJson: string;
    finalText?: string;
    id?: string;
  }): AgentRunRow {
    const id = input.id ?? newId();
    this.db
      .prepare(
        "INSERT INTO agent_runs (id, task_id, phase, model_id, status, rounds, tool_calls, denials, transcript_json, final_text) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        input.taskId,
        input.phase,
        input.modelId ?? null,
        input.status,
        input.rounds,
        input.toolCalls,
        input.denials,
        input.transcriptJson,
        input.finalText ?? null,
      );
    return this.get(id);
  }
  get(id: string): AgentRunRow {
    const row = this.db.prepare("SELECT * FROM agent_runs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (row === undefined) throw new Error(`agent run not found: ${id}`);
    return mapAgentRun(row);
  }
  /** Project/task-scoped listing (T20: never cross-scope). */
  listByTask(taskId: string): readonly AgentRunRow[] {
    return Object.freeze(
      this.db.prepare("SELECT * FROM agent_runs WHERE task_id = ? ORDER BY created_at, id").all(taskId).map(mapAgentRun),
    );
  }
  latestByPhase(taskId: string, phase: AgentRunRow["phase"]): AgentRunRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM agent_runs WHERE task_id = ? AND phase = ? ORDER BY created_at DESC, id DESC LIMIT 1")
      .get(taskId, phase) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : mapAgentRun(row);
  }
}
