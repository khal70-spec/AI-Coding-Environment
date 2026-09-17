#!/usr/bin/env node
// aice — operator/CI CLI. Offline by design (Plan §38); no network is ever used.
// Phase 1 surface: projects, tasks (state machine), approvals, checkpoints,
// workspaces (isolated git worktrees), verify/review evidence, audit trail.
// Everything exits non-zero on denial — usable directly as a CI gate.

const VERSION = "0.3.0-phase2";

// ---------------------------------------------------------------- help / doctor
function help(): string {
  return [
    `aice ${VERSION} — AI Coding Environment operator CLI (offline)`,
    "",
    "Usage: aice <command> [args] [--db PATH] [--by ACTOR] [--json]",
    "",
    "Global flags:",
    "  --db PATH     SQLite path (env DB_PATH, default .local/app.db)",
    "  --by ACTOR    actor recorded in runs/audit (default: operator)",
    "  --json        machine-readable output on list/show/audit",
    "",
    "Commands:",
    "  version                          Print version",
    "  help                             Print this help",
    "  doctor                           Offline environment self-check",
    "  migrate                          Apply SQLite migrations (idempotent)",
    "  project create --name N --path P [--classification C]",
    "  project list [--all]",
    "  project archive <id>",
    "  task create --project ID --title T [--risk low|medium|high] [--classification C]",
    "  task list [--project ID]",
    "  task show <id>                   State + runs + audit trail",
    "  task advance <id> [--to STATE]   Guarded forward transition (fails closed)",
    "  task fail <id> --to BLOCKED|CANCELLED|FAILED|ROLLBACK_REQUIRED [--reason R]",
    "  approve plan|final <id>          Risk-gated approval (Plan §33)",
    "  checkpoint <id>                  Record git checkpoint evidence (read-only)",
    "  workspace prepare <id>           Approval gate → checkpoint → isolated worktree",
    "  workspace list [--project ID]",
    "  workspace remove <id>",
    "  verify <id> --tests green|red --scans green|red",
    "  review <id> --by AGENT           Independent review evidence (Plan §3.6)",
    "  audit (--task ID | --project ID) Audit trail (redacted)",
    "",
    "Denials exit 1 and are written to the audit trail.",
  ].join("\n");
}

// Minimum runtime: type-stripping (.ts execution) is flag-free from Node 22.18 on.
const MIN_NODE = { major: 22, minor: 18 };
function nodeOk(version: string): boolean {
  const [maj = "0", min = "0"] = version.split(".");
  return Number(maj) > MIN_NODE.major || (Number(maj) === MIN_NODE.major && Number(min) >= MIN_NODE.minor);
}

async function doctor(): Promise<{ ok: boolean; lines: string[] }> {
  const lines: string[] = [];
  const nodeGood = nodeOk(process.versions.node);
  lines.push(
    `node: ${process.version} ${nodeGood ? "OK" : `FAIL (need >= ${MIN_NODE.major}.${MIN_NODE.minor} — type-stripping)`}`,
  );
  const { access } = await import("node:fs/promises");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const layout = [
    "packages/core/src/index.ts",
    "packages/policy/src/index.ts",
    "packages/storage/schema.sql",
    "packages/storage/migrations/001_initial.sql",
  ];
  for (const p of layout) {
    try {
      await access(join(root, p));
      lines.push(`${p}: OK`);
    } catch {
      lines.push(`${p}: MISSING`);
    }
  }
  const ok = nodeGood && lines.every((l) => !l.includes("MISSING") && !l.includes("FAIL"));
  return { ok, lines };
}

// ---------------------------------------------------------------- arg parsing
interface Parsed {
  readonly pos: readonly string[];
  readonly flags: ReadonlyMap<string, string | true>;
}
function parseArgs(argv: readonly string[]): Parsed {
  const flags = new Map<string, string | true>();
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, true);
      }
    } else {
      pos.push(a);
    }
  }
  return { pos, flags };
}
function flagString(flags: ReadonlyMap<string, string | true>, name: string): string | undefined {
  const v = flags.get(name);
  return v === undefined || v === true ? undefined : v;
}
function needFlag(flags: ReadonlyMap<string, string | true>, name: string): string {
  const v = flagString(flags, name);
  if (v === undefined || v === "") throw new CliError("USAGE", `missing required --${name}`);
  return v;
}
class CliError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CliError";
    this.code = code;
  }
}
function enumFlag<T extends string>(
  flags: ReadonlyMap<string, string | true>,
  name: string,
  allowed: readonly T[],
  fallback?: T,
): T {
  const v = flagString(flags, name);
  if (v === undefined) {
    if (fallback !== undefined) return fallback;
    throw new CliError("USAGE", `missing required --${name} (${allowed.join("|")})`);
  }
  if (!(allowed as readonly string[]).includes(v)) {
    throw new CliError("USAGE", `--${name} must be one of: ${allowed.join("|")}`);
  }
  return v as T;
}

// ---------------------------------------------------------------- services
import { resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import { openDatabase, ProjectsDao, TasksDao, RunsDao, WorkspacesDao, AuditDao } from "../../../packages/storage/src/index.ts";
import type { OpenedDatabase } from "../../../packages/storage/src/index.ts";
import { TaskEngine, WorkspaceService } from "../../../packages/orchestrator/src/index.ts";
import { GitRunner } from "../../../packages/git/src/runner.ts";
import { redact } from "../../../packages/security/src/index.ts";
import type { TaskState, DataClassification, RiskLevel } from "../../../packages/core/src/index.ts";

const CLASSIFICATIONS: readonly DataClassification[] = ["public", "internal", "confidential", "restricted"];
const RISKS: readonly RiskLevel[] = ["low", "medium", "high"];
const STATES: readonly TaskState[] = [
  "CREATED", "CLASSIFYING", "INVESTIGATING", "PLANNING", "WAITING_APPROVAL",
  "PREPARING_WORKSPACE", "IMPLEMENTING", "TESTING", "SECURITY_REVIEW", "AI_REVIEW",
  "FIXING", "VERIFYING", "READY", "APPROVED", "MERGED", "BLOCKED", "CANCELLED",
  "FAILED", "ROLLBACK_REQUIRED",
];
const FAILURE_TARGETS: readonly TaskState[] = ["BLOCKED", "CANCELLED", "FAILED", "ROLLBACK_REQUIRED"];

interface Services {
  opened: OpenedDatabase;
  projects: ProjectsDao;
  tasks: TasksDao;
  runs: RunsDao;
  workspaces: WorkspacesDao;
  audit: AuditDao;
  engine: TaskEngine;
  wservice: WorkspaceService;
}
function openServices(dbPath: string): Services {
  const opened = openDatabase(dbPath);
  const projects = new ProjectsDao(opened.db);
  const tasks = new TasksDao(opened.db);
  const runs = new RunsDao(opened.db);
  const workspaces = new WorkspacesDao(opened.db);
  const audit = new AuditDao(opened.db);
  const engine = new TaskEngine({ tasks, runs, audit });
  const wservice = new WorkspaceService({ projects, tasks, runs, workspaces, audit }, engine);
  return { opened, projects, tasks, runs, workspaces, audit, engine, wservice };
}

interface Out {
  json: boolean;
  print(row: unknown, text: string): void;
  err(code: string, message: string): void;
}
function makeOut(flags: ReadonlyMap<string, string | true>): Out {
  const json = flags.get("json") === true;
  return {
    json,
    print(row: unknown, text: string): void {
      console.log(json ? JSON.stringify(row) : text);
    },
    err(code: string, message: string): void {
      process.stderr.write(`error: ${code} ${message}\n`);
    },
  };
}

/** Defense-in-depth: detail payloads are redacted again at print time. */
function redactedDetail(detail: unknown): string {
  return redact(JSON.stringify(detail ?? {})).text;
}

// ---------------------------------------------------------------- commands
async function main(pos0: string | undefined, rest: readonly string[], global: Parsed): Promise<number> {
  const out = makeOut(global.flags);
  const dbPath = resolve(flagString(global.flags, "db") ?? process.env.DB_PATH ?? ".local/app.db");
  const actor = flagString(global.flags, "by") ?? "operator";
  const pos = rest; // sub-positionals only; flags were parsed globally

  if (pos0 === undefined || pos0 === "help") {
    console.log(help());
    return 0;
  }
  if (pos0 === "version") {
    console.log(VERSION);
    return 0;
  }
  if (pos0 === "doctor") {
    const { ok, lines } = await doctor();
    console.log(lines.join("\n"));
    return ok ? 0 : 1;
  }

  const s = openServices(dbPath);
  try {
    switch (pos0) {
      case "migrate": {
        out.print(s.opened.migrations, `db ${s.opened.path}: ${s.opened.migrations.applied.length} applied, ${s.opened.migrations.skipped.length} skipped, ${s.opened.migrations.total} total`);
        return 0;
      }

      case "project": {
        const sub = pos[0];
        if (sub === "create") {
          const name = needFlag(global.flags, "name");
          const rootPath = resolve(needFlag(global.flags, "path"));
          if (!existsSync(rootPath) || !statSync(rootPath).isDirectory()) {
            throw new CliError("NOT_A_DIRECTORY", `project path is not a directory: ${rootPath}`);
          }
          const classification = enumFlag(global.flags, "classification", CLASSIFICATIONS, "internal" as DataClassification);
          const p = s.projects.create({ name, rootPath, classification });
          s.audit.append({ actor, action: "project.create", target: p.id, projectId: p.id, detail: { name, rootPath, classification } });
          out.print(p, `project ${p.id} ${p.name} (${p.rootPath}) [${p.classification}]`);
          return 0;
        }
        if (sub === "list") {
          const rows = s.projects.list(global.flags.get("all") !== true);
          out.print(rows, rows.map((p) => `${p.id}\t${p.name}\t${p.classification}\t${p.rootPath}`).join("\n"));
          return 0;
        }
        if (sub === "archive") {
          const id = pos[1] ?? throwUsage("project archive <id>");
          s.projects.archive(id);
          s.audit.append({ actor, action: "project.archive", target: id, projectId: id });
          out.print({ id }, `project ${id} archived`);
          return 0;
        }
        throwUsage("project create|list|archive");
      }

      case "task": {
        const sub = pos[0];
        if (sub === "create") {
          const projectId = needFlag(global.flags, "project");
          const title = needFlag(global.flags, "title");
          s.projects.get(projectId); // exists?
          const risk = enumFlag(global.flags, "risk", RISKS, "medium" as RiskLevel);
          const classification = enumFlag(global.flags, "classification", CLASSIFICATIONS, "internal" as DataClassification);
          const t = s.tasks.create({ projectId, title, risk, classification });
          s.audit.append({ actor, action: "task.create", target: t.id, projectId, taskId: t.id, detail: { title, risk, classification } });
          out.print(t, `task ${t.id} [${t.state}] risk=${t.risk} ${t.title}`);
          return 0;
        }
        if (sub === "list") {
          const projectId = flagString(global.flags, "project");
          const rows = projectId !== undefined
            ? s.tasks.listByProject(projectId)
            : s.projects.list().flatMap((p) => [...s.tasks.listByProject(p.id)]);
          out.print(rows, rows.map((t) => `${t.id}\t${t.state}\t${t.risk}\t${t.title}`).join("\n"));
          return 0;
        }
        if (sub === "show") {
          const id = pos[1] ?? throwUsage("task show <id>");
          const t = s.tasks.get(id);
          const runs = s.runs.listByTask(id);
          const audit = s.audit.listByTask(id);
          const bundle = { task: t, runs, audit };
          if (out.json) {
            out.print(bundle, "");
          } else {
            console.log(`task ${t.id}\nstate: ${t.state}\nrisk: ${t.risk}\nclassification: ${t.classification}\ntitle: ${t.title}`);
            console.log("runs:");
            for (const r of runs) console.log(`  ${r.startedAt} ${r.fromState} → ${r.toState} (${r.agent})`);
            console.log("audit:");
            for (const a of audit) console.log(`  #${a.id} ${a.at} ${a.action} ${a.decision ?? ""} ${redactedDetail(a.detail)}`);
          }
          return 0;
        }
        if (sub === "advance") {
          const id = pos[1] ?? throwUsage("task advance <id>");
          const to = flagString(global.flags, "to");
          let toState: TaskState | undefined;
          if (to !== undefined) toState = enumFlag(global.flags, "to", STATES);
          const r = s.engine.transition({ taskId: id, to: toState, actor });
          if (!r.ok) {
            out.err(r.error.code, r.error.message);
            return 1;
          }
          out.print(r.value, `task ${id}: ${r.value.from} → ${r.value.to}`);
          return 0;
        }
        if (sub === "fail") {
          const id = pos[1] ?? throwUsage("task fail <id>");
          const to = enumFlag(global.flags, "to", FAILURE_TARGETS);
          const reason = flagString(global.flags, "reason") ?? "operator requested";
          const r = s.engine.transition({ taskId: id, to, actor });
          if (!r.ok) {
            out.err(r.error.code, r.error.message);
            return 1;
          }
          s.audit.append({ actor, action: "task.fail.reason", target: id, taskId: id, detail: { reason } });
          out.print({ id, to }, `task ${id} → ${to} (${reason})`);
          return 0;
        }
        throwUsage("task create|list|show|advance|fail");
      }

      case "approve": {
        const kind = pos[0];
        if (kind !== "plan" && kind !== "final") throwUsage("approve plan|final <id>");
        const id = pos[1] ?? throwUsage(`approve ${kind} <id>`);
        s.tasks.get(id);
        s.engine.approve(id, kind, actor);
        out.print({ id, kind, by: actor }, `approval recorded: ${kind} on ${id} by ${actor}`);
        return 0;
      }

      case "checkpoint": {
        const id = pos[0] ?? throwUsage("checkpoint <id>");
        const t = s.tasks.get(id);
        const project = s.projects.get(t.projectId);
        const runner = new GitRunner(project.rootPath);
        const cp = runner.checkpoint(); // read-only evidence
        s.engine.recordCheckpoint(id, cp, actor);
        out.print(cp, `checkpoint ${cp.sha.slice(0, 12)} on ${cp.branch}${cp.dirty ? " (tree dirty — recorded, not modified)" : ""}`);
        return 0;
      }

      case "workspace": {
        const sub = pos[0];
        if (sub === "prepare") {
          const id = pos[1] ?? throwUsage("workspace prepare <taskId>");
          const r = s.wservice.prepare(id, actor);
          if (!r.ok) {
            out.err(r.error.code, r.error.message);
            return 1;
          }
          out.print(r.value, `workspace ${r.value.id}\n  path:   ${r.value.path}\n  branch: ${r.value.branch}\n  base:   ${r.value.baseSha.slice(0, 12)}`);
          return 0;
        }
        if (sub === "list") {
          const projectId = flagString(global.flags, "project");
          const rows = projectId !== undefined
            ? s.workspaces.listByProject(projectId)
            : s.projects.list().flatMap((p) => [...s.workspaces.listByProject(p.id)]);
          out.print(rows, rows.map((w) => `${w.id}\t${w.state}\t${w.branch}\t${w.path}`).join("\n"));
          return 0;
        }
        if (sub === "remove") {
          const id = pos[1] ?? throwUsage("workspace remove <id>");
          const r = s.wservice.remove(id, actor);
          if (!r.ok) {
            out.err(r.error.code, r.error.message);
            return 1;
          }
          out.print({ id }, `workspace ${id} removed`);
          return 0;
        }
        throwUsage("workspace prepare|list|remove");
      }

      case "verify": {
        const id = pos[0] ?? throwUsage("verify <id>");
        const tests = enumFlag(global.flags, "tests", ["green", "red"] as const);
        const scans = enumFlag(global.flags, "scans", ["green", "red"] as const);
        s.tasks.get(id);
        s.engine.recordVerify(id, { testsGreen: tests === "green", scansGreen: scans === "green" }, actor);
        out.print({ id, testsGreen: tests === "green", scansGreen: scans === "green" }, `verify recorded on ${id}: tests=${tests} scans=${scans}`);
        return 0;
      }

      case "review": {
        const id = pos[0] ?? throwUsage("review <id>");
        const agent = needFlag(global.flags, "by");
        s.tasks.get(id);
        s.engine.recordReview(id, agent, actor);
        out.print({ id, reviewer: agent }, `review recorded on ${id}: reviewer=${agent}`);
        return 0;
      }

      case "audit": {
        const taskId = flagString(global.flags, "task");
        const projectId = flagString(global.flags, "project");
        if (taskId === undefined && projectId === undefined) throwUsage("audit --task ID | --project ID");
        const rows = taskId !== undefined ? s.audit.listByTask(taskId) : s.audit.listByProject(projectId as string);
        out.print(
          rows,
          rows.map((a) => `#${a.id}\t${a.at}\t${a.actor}\t${a.action}\t${a.decision ?? ""}\t${redactedDetail(a.detail)}`).join("\n"),
        );
        return 0;
      }

      default:
        console.log(help());
        return 1;
    }
  } finally {
    s.opened.db.close();
  }
}

function throwUsage(msg: string): never {
  throw new CliError("USAGE", `usage: aice ${msg}`);
}

try {
  const global = parseArgs(process.argv.slice(2));
  const code = await main(global.pos[0], global.pos.slice(1), global);
  process.exit(code);
} catch (err) {
  if (err instanceof CliError) {
    process.stderr.write(`error: ${err.code} ${err.message}\n`);
    process.exit(2);
  }
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
