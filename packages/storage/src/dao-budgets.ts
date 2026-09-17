// Budget DAOs — Plan §13 (P2.7). budgets = limits per provider/model per window;
// budget_events = append-only usage ledger (usage numbers + computed cost ONLY —
// never prompts, completions, or any message content).
import { randomUUID } from "node:crypto";
import type { SqliteDb } from "./migrate.ts";

export type BudgetScope = "provider" | "model";
export type BudgetWindow = "daily" | "weekly" | "monthly" | "total";

const SCOPES: readonly string[] = ["provider", "model"];
const WINDOWS: readonly string[] = ["daily", "weekly", "monthly", "total"];

export interface BudgetRow {
  readonly id: string;
  readonly scope: BudgetScope;
  readonly scopeId: string;
  readonly window: BudgetWindow;
  readonly limitUsd: number | null;
  readonly limitTokensIn: number | null;
  readonly limitTokensOut: number | null;
  readonly hardBlock: boolean;
  readonly createdAt: string;
}

export interface BudgetUpsert {
  readonly scope: BudgetScope;
  readonly scopeId: string;
  readonly window: BudgetWindow;
  readonly limitUsd?: number | null;
  readonly limitTokensIn?: number | null;
  readonly limitTokensOut?: number | null;
  readonly hardBlock?: boolean;
}

function toBudgetRow(r: Record<string, unknown>): BudgetRow {
  return {
    id: String(r["id"]),
    scope: String(r["scope"]) as BudgetScope,
    scopeId: String(r["scope_id"]),
    window: String(r["window"]) as BudgetWindow,
    limitUsd: r["limit_usd"] === null ? null : Number(r["limit_usd"]),
    limitTokensIn: r["limit_tokens_in"] === null ? null : Number(r["limit_tokens_in"]),
    limitTokensOut: r["limit_tokens_out"] === null ? null : Number(r["limit_tokens_out"]),
    hardBlock: Number(r["hard_block"]) === 1,
    createdAt: String(r["created_at"]),
  };
}

export class BudgetsDao {
  private db: SqliteDb;
  constructor(db: SqliteDb) {
    this.db = db;
  }

  /** Upsert keyed by (scope, scopeId, window). At least one limit must be set. */
  set(input: BudgetUpsert): string {
    if (!SCOPES.includes(input.scope)) throw new Error(`invalid budget scope: ${input.scope}`);
    if (!WINDOWS.includes(input.window)) throw new Error(`invalid budget window: ${input.window}`);
    if (input.scopeId.trim() === "") throw new Error("budget scope id required");
    const lu = input.limitUsd ?? null;
    const ti = input.limitTokensIn ?? null;
    const to = input.limitTokensOut ?? null;
    if (lu === null && ti === null && to === null) {
      throw new Error("a budget needs at least one limit (usd, tokens-in or tokens-out)");
    }
    for (const [name, v] of [["limitUsd", lu], ["limitTokensIn", ti], ["limitTokensOut", to]] as const) {
      if (v !== null && (!Number.isFinite(v) || v < 0)) throw new Error(`${name} must be a non-negative number`);
    }
    const existing = this.db
      .prepare("SELECT id FROM budgets WHERE scope = ? AND scope_id = ? AND window = ?")
      .get(input.scope, input.scopeId, input.window) as { id?: unknown } | undefined;
    const id = existing?.id !== undefined ? String(existing.id) : randomUUID();
    this.db
      .prepare(
        `INSERT INTO budgets (id, scope, scope_id, window, limit_usd, limit_tokens_in, limit_tokens_out, hard_block)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           limit_usd = excluded.limit_usd,
           limit_tokens_in = excluded.limit_tokens_in,
           limit_tokens_out = excluded.limit_tokens_out,
           hard_block = excluded.hard_block`,
      )
      .run(id, input.scope, input.scopeId, input.window, lu, ti, to, input.hardBlock === false ? 0 : 1);
    return id;
  }

  get(id: string): BudgetRow | undefined {
    const row = this.db.prepare("SELECT * FROM budgets WHERE id = ?").get(id);
    return row === undefined ? undefined : toBudgetRow(row);
  }

  list(opts: { scope?: BudgetScope; scopeId?: string } = {}): readonly BudgetRow[] {
    const rows = (
      opts.scope !== undefined
        ? opts.scopeId !== undefined
          ? this.db
              .prepare("SELECT * FROM budgets WHERE scope = ? AND scope_id = ? ORDER BY created_at")
              .all(opts.scope, opts.scopeId)
          : this.db.prepare("SELECT * FROM budgets WHERE scope = ? ORDER BY created_at").all(opts.scope)
        : this.db.prepare("SELECT * FROM budgets ORDER BY created_at").all()
    ) as Record<string, unknown>[];
    return Object.freeze(rows.map(toBudgetRow));
  }

  remove(id: string): void {
    this.db.prepare("DELETE FROM budgets WHERE id = ?").run(id);
  }
}

export interface BudgetEventRow {
  readonly id: number;
  readonly at: string;
  readonly providerId: string;
  readonly modelId: string | null;
  readonly taskId: string | null;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costUsd: number;
  readonly decision: "allowed" | "blocked";
  readonly detail: string | null;
}

export interface BudgetEventAppend {
  readonly providerId: string;
  readonly modelId?: string;
  readonly taskId?: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costUsd: number;
  readonly decision: "allowed" | "blocked";
  readonly detail?: string;
  readonly at?: string; // ISO; tests inject clock boundaries
}

function toEventRow(r: Record<string, unknown>): BudgetEventRow {
  return {
    id: Number(r["id"]),
    at: String(r["at"]),
    providerId: String(r["provider_id"]),
    modelId: r["model_id"] === null ? null : String(r["model_id"]),
    taskId: r["task_id"] === null ? null : String(r["task_id"]),
    tokensIn: Number(r["tokens_in"]),
    tokensOut: Number(r["tokens_out"]),
    costUsd: Number(r["cost_usd"]),
    decision: String(r["decision"]) as "allowed" | "blocked",
    detail: r["detail"] === null ? null : String(r["detail"]),
  };
}

export interface SpendSums {
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costUsd: number;
  readonly events: number;
}

export class BudgetEventsDao {
  private db: SqliteDb;
  constructor(db: SqliteDb) {
    this.db = db;
  }

  append(input: BudgetEventAppend): void {
    this.db
      .prepare(
        `INSERT INTO budget_events (at, provider_id, model_id, task_id, tokens_in, tokens_out, cost_usd, decision, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.at ?? new Date().toISOString(),
        input.providerId,
        input.modelId ?? null,
        input.taskId ?? null,
        Math.trunc(input.tokensIn),
        Math.trunc(input.tokensOut),
        input.costUsd,
        input.decision,
        input.detail ?? null,
      );
  }

  /** Usage in [startIso, +∞). Scope column chooses provider- or model-level views. */
  sumsSince(
    scope: BudgetScope,
    scopeId: string,
    startIso: string | null,
    opts: { allowedOnly?: boolean } = {},
  ): SpendSums {
    const col = scope === "provider" ? "provider_id" : "model_id";
    const clauses = [`${col} = ?`];
    const params: (string | number)[] = [scopeId];
    if (startIso !== null) {
      clauses.push("at >= ?");
      params.push(startIso);
    }
    if (opts.allowedOnly !== false) clauses.push("decision = 'allowed'");
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(tokens_in),0) ti, COALESCE(SUM(tokens_out),0) to_, COALESCE(SUM(cost_usd),0) cu, COUNT(*) n
         FROM budget_events WHERE ${clauses.join(" AND ")}`,
      )
      .get(...params);
    return {
      tokensIn: Number(row?.["ti"] ?? 0),
      tokensOut: Number(row?.["to_"] ?? 0),
      costUsd: Number(row?.["cu"] ?? 0),
      events: Number(row?.["n"] ?? 0),
    };
  }

  listRecent(opts: { providerId?: string; limit?: number } = {}): readonly BudgetEventRow[] {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
    const rows = (
      opts.providerId !== undefined
        ? this.db
            .prepare("SELECT * FROM budget_events WHERE provider_id = ? ORDER BY id DESC LIMIT ?")
            .all(opts.providerId, limit)
        : this.db.prepare("SELECT * FROM budget_events ORDER BY id DESC LIMIT ?").all(limit)
    ) as Record<string, unknown>[];
    return Object.freeze(rows.map(toEventRow));
  }
}
