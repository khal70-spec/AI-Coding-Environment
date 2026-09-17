// DAOs: test_results + security_findings — Plan §22/§24, P3.4. The verify gates
// read these tables; they are the machine-checkable half of "green means green".
// Rows are task-scoped evidence; output/logs live elsewhere (output_ref is a
// pointer, never inline content).
import type { DatabaseSync } from "node:sqlite";

type Row = Record<string, unknown>;
const asString = (v: unknown): string => v as string;
const asNumber = (v: unknown): number => Number(v);

export type FindingSeverity = "info" | "low" | "medium" | "high" | "critical";
export type FindingStatus = "open" | "acknowledged" | "fixed" | "wontfix";

export interface TestResultRow {
  readonly id: number;
  readonly taskId: string;
  readonly suite: string;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly outputRef: string | null;
  readonly at: string;
}

export interface FindingRow {
  readonly id: number;
  readonly taskId: string;
  readonly severity: FindingSeverity;
  readonly ruleId: string;
  readonly location: string | null;
  readonly summary: string;
  readonly status: FindingStatus;
  readonly at: string;
}

function mapTestResult(r: Row): TestResultRow {
  return {
    id: asNumber(r["id"]),
    taskId: asString(r["task_id"]),
    suite: asString(r["suite"]),
    passed: asNumber(r["passed"]),
    failed: asNumber(r["failed"]),
    skipped: asNumber(r["skipped"]),
    outputRef: (r["output_ref"] as string | null) ?? null,
    at: asString(r["at"]),
  };
}

function mapFinding(r: Row): FindingRow {
  return {
    id: asNumber(r["id"]),
    taskId: asString(r["task_id"]),
    severity: asString(r["severity"]) as FindingSeverity,
    ruleId: asString(r["rule_id"]),
    location: (r["location"] as string | null) ?? null,
    summary: asString(r["summary"]),
    status: asString(r["status"]) as FindingStatus,
    at: asString(r["at"]),
  };
}

export class TestResultsDao {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  add(
    taskId: string,
    input: { suite: string; passed: number; failed: number; skipped?: number; outputRef?: string },
  ): TestResultRow {
    const stmt = this.db.prepare(
      "INSERT INTO test_results (task_id, suite, passed, failed, skipped, output_ref) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const r = stmt.run(taskId, input.suite, input.passed, input.failed, input.skipped ?? 0, input.outputRef ?? null);
    return this.byId(Number(r.lastInsertRowid));
  }

  byId(id: number): TestResultRow {
    const row = this.db.prepare("SELECT * FROM test_results WHERE id = ?").get(id) as Row | undefined;
    if (row === undefined) throw new Error(`test_results row not found: ${id}`);
    return mapTestResult(row);
  }

  byTask(taskId: string): readonly TestResultRow[] {
    const rows = this.db
      .prepare("SELECT * FROM test_results WHERE task_id = ? ORDER BY id ASC")
      .all(taskId) as Row[];
    return rows.map(mapTestResult);
  }

  /** Newest row per suite for the task (recency is per-suite — one stale suite is enough). */
  latestByTask(taskId: string): TestResultRow | null {
    const row = this.db
      .prepare("SELECT * FROM test_results WHERE task_id = ? ORDER BY id DESC LIMIT 1")
      .get(taskId) as Row | undefined;
    return row === undefined ? null : mapTestResult(row);
  }
}

export class FindingsDao {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  add(
    taskId: string,
    input: { severity: FindingSeverity; ruleId: string; location?: string | null; summary: string },
  ): FindingRow {
    const r = this.db
      .prepare("INSERT INTO security_findings (task_id, severity, rule_id, location, summary) VALUES (?, ?, ?, ?, ?)")
      .run(taskId, input.severity, input.ruleId, input.location ?? null, input.summary);
    return this.byId(Number(r.lastInsertRowid));
  }

  addMany(taskId: string, items: readonly { severity: FindingSeverity; ruleId: string; location?: string | null; summary: string }[]): number {
    const stmt = this.db.prepare(
      "INSERT INTO security_findings (task_id, severity, rule_id, location, summary) VALUES (?, ?, ?, ?, ?)",
    );
    let n = 0;
    for (const it of items) {
      stmt.run(taskId, it.severity, it.ruleId, it.location ?? null, it.summary);
      n += 1;
    }
    return n;
  }

  byId(id: number): FindingRow {
    const row = this.db.prepare("SELECT * FROM security_findings WHERE id = ?").get(id) as Row | undefined;
    if (row === undefined) throw new Error(`security_findings row not found: ${id}`);
    return mapFinding(row);
  }

  byTask(taskId: string): readonly FindingRow[] {
    const rows = this.db
      .prepare("SELECT * FROM security_findings WHERE task_id = ? ORDER BY id ASC")
      .all(taskId) as Row[];
    return rows.map(mapFinding);
  }

  countByTask(taskId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM security_findings WHERE task_id = ?")
      .get(taskId) as Row;
    return asNumber(row["n"]);
  }

  /** Open findings at HIGH or CRITICAL — the merge/verify blockers list. */
  openBlockers(taskId: string): readonly FindingRow[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM security_findings WHERE task_id = ? AND status = 'open' AND severity IN ('high','critical') ORDER BY id ASC",
      )
      .all(taskId) as Row[];
    return rows.map(mapFinding);
  }

  updateStatus(id: number, status: FindingStatus): FindingRow {
    this.db.prepare("UPDATE security_findings SET status = ? WHERE id = ?").run(status, id);
    return this.byId(id);
  }
}
