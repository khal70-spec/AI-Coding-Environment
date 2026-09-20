#!/usr/bin/env node
// aice — operator/CI CLI. Offline by design (Plan §38); no network is ever used.
// Phase 1 surface: projects, tasks (state machine), approvals, checkpoints,
// workspaces (isolated git worktrees), verify/review evidence, audit trail.
// Phase 2 surface: providers (egress-gated, classification-gated), vault keys
// (stdin only), model discovery + capability probes, budgets (hard-block).
// Everything exits non-zero on denial — usable directly as a CI gate.

const VERSION = "1.0.3";

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
    "  tests record <id> --suite S --passed N [--failed N] [--skipped N]",
    "  findings add <id> --severity S --rule R --summary T [--location L]",
    "  findings list <id> | findings resolve <rowId> --status S",
    "  verify <id> --tests green|red --scans green|red",
    "  review <id> --by AGENT           Independent review evidence (Plan §3.6)",
    "  audit (--task ID | --project ID) Audit trail (redacted)",
    "",
    "  provider add --name N --protocol P [--base-url U] [--max-classification C] [--config-json J]",
    "  provider list",
    "  provider remove <id>",
    "  provider test <id>               Structured connection probe (fails exit 1)",
    "  provider key set <id> --stdin    Read key from STDIN ONLY (never argv/files)",
    "  provider key remove <id>",
    "  provider key status <id>",
    "  model list [--provider ID]",
    "  model discover <provider-id>     Merge provider discovery into the registry",
    "  model probe <id>|--provider ID   Capability round-trip probe (fails exit 1)",
    "  budget set --provider|--model ID --window daily|weekly|monthly|total [--usd N|--in N|--out N]",
    "  budget list",
    "  budget events [--provider ID] [--limit N]",
    "  budget remove <id>",
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
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync, statSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import {
  openDatabase,
  ProjectsDao,
  TasksDao,
  RunsDao,
  WorkspacesDao,
  AuditDao,
  AgentRunsDao,
  TestResultsDao,
  FindingsDao,
  ProvidersDao,
  ProviderCredentialsDao,
  ModelsDao,
  BudgetsDao,
  BudgetEventsDao,
} from "../../../packages/storage/src/index.ts";
import type { OpenedDatabase } from "../../../packages/storage/src/index.ts";
import {
  PROTOCOL_DEFAULT_BASE,
  ProviderDispatcher,
  ProviderError,
  BudgetEnforcer,
  assertProviderEndpoint,
  discoverIntoDb,
  probeModel,
  probeAll,
} from "../../../packages/providers/src/index.ts";
import type { ProviderConfig, ProviderEventSink } from "../../../packages/providers/src/index.ts";
import { detectVault, last4Of, secretRef, secretValue } from "../../../packages/secrets/src/index.ts";
import type { VaultSelection } from "../../../packages/secrets/src/index.ts";
import { TaskEngine, WorkspaceService } from "../../../packages/orchestrator/src/index.ts";
import { GitRunner } from "../../../packages/git/src/runner.ts";
import { redact } from "../../../packages/security/src/index.ts";
import { ToolRunner } from "../../../packages/tools/src/runtime.ts";
import { FS_TOOLS } from "../../../packages/tools/src/fs-tools.ts";
import { GIT_TOOLS } from "../../../packages/tools/src/git-tools.ts";
import { TEST_RUNNER_TOOLS } from "../../../packages/tools/src/test-runner-tool.ts";
import { BUILTIN_MANIFESTS } from "../../../packages/agents/src/index.ts";
import { buildRepoIndex, persistRepoIndex, packWorkspace } from "../../../packages/context/src/index.ts";
import { McpServersDao, PermissionsDao, SkillsDao } from "../../../packages/storage/src/index.ts";
import { validateMcpConfig, decideMcpCall, McpClient, parseSkillManifest, digestSkillBundle, decideSkillUse } from "../../../packages/mcp/src/index.ts";
import { classifyTask, routeTask } from "../../../packages/context/src/routing.ts";
import { investigate } from "../../../packages/agents/src/investigator.ts";
import { architectPlan } from "../../../packages/agents/src/architect.ts";
import { implement } from "../../../packages/agents/src/implementer.ts";
import type { AgentTransport, AgentMessage, AgentRunResult } from "../../../packages/agents/src/runtime.ts";
import type { PolicyContext } from "../../../packages/policy/src/index.ts";
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
  testResults: TestResultsDao;
  findings: FindingsDao;
  engine: TaskEngine;
  wservice: WorkspaceService;
  providers: ProvidersDao;
  creds: ProviderCredentialsDao;
  models: ModelsDao;
  budgets: BudgetsDao;
  bEvents: BudgetEventsDao;
  agentRuns: AgentRunsDao;
  mcpServers: McpServersDao;
  permissions: PermissionsDao;
  skills: SkillsDao;
}
function openServices(dbPath: string): Services {
  const opened = openDatabase(dbPath);
  const projects = new ProjectsDao(opened.db);
  const tasks = new TasksDao(opened.db);
  const runs = new RunsDao(opened.db);
  const workspaces = new WorkspacesDao(opened.db);
  const audit = new AuditDao(opened.db);
  const testResults = new TestResultsDao(opened.db);
  const findings = new FindingsDao(opened.db);
  const engine = new TaskEngine({ tasks, runs, audit, testResults, findings });
  const wservice = new WorkspaceService({ projects, tasks, runs, workspaces, audit, testResults, findings }, engine);
  const providers = new ProvidersDao(opened.db);
  const creds = new ProviderCredentialsDao(opened.db);
  const models = new ModelsDao(opened.db);
  const budgets = new BudgetsDao(opened.db);
  const bEvents = new BudgetEventsDao(opened.db);
  return {
    opened, projects, tasks, runs, workspaces, audit, testResults, findings, engine, wservice,
    providers, creds, models, budgets, bEvents,
    agentRuns: new AgentRunsDao(opened.db),
    mcpServers: new McpServersDao(opened.db),
    permissions: new PermissionsDao(opened.db),
    skills: new SkillsDao(opened.db),
  };
}

/** Content-free provider events → append-only audit trail. */
function auditSinkFor(s: Services, actor: string): ProviderEventSink {
  return (e) => {
    try {
      s.audit.append({
        actor,
        action: e.kind,
        target: e.model !== undefined ? `${e.providerId}/${e.model}` : e.providerId,
        decision: e.kind.includes("denied") || e.kind.includes("failed") ? "deny" : "allow",
        detail: {
          providerId: e.providerId,
          model: e.model ?? null,
          code: e.code ?? null,
          detail: e.detail ?? null,
          inputTokens: e.inputTokens ?? null,
          outputTokens: e.outputTokens ?? null,
        },
      });
    } catch {
      // audit is best-effort at the CLI layer; the engine layer never reaches here
    }
  };
}

/** Build a dispatcher wired to vault + audit + budget extraction for commands. */
async function makeDispatcher(s: Services, actor: string): Promise<{ dispatcher: ProviderDispatcher; vaultSel: VaultSelection }> {
  const vaultSel = await detectVault();
  const sink = auditSinkFor(s, actor);
  const enforcer = new BudgetEnforcer({ budgets: s.budgets, events: s.bEvents, models: s.models, audit: sink });
  return {
    vaultSel,
    dispatcher: new ProviderDispatcher({ vault: vaultSel.vault, audit: sink, budget: enforcer }),
  };
}

/** Compose an adapter config from the DB row (+ its credential ref) for a provider id. */
function configForProvider(s: Services, providerId: string): ProviderConfig {
  const row = s.providers.get(providerId);
  if (row === undefined) throw new CliError("NOT_FOUND", `unknown provider: ${providerId}`);
  const credRow = s.creds.get(providerId);
  const config = ((): Record<string, unknown> => {
    try {
      return JSON.parse(row.configJson) as Record<string, unknown>;
    } catch {
      throw new CliError("INVALID_CONFIG", `provider ${providerId} config_json is not parseable`);
    }
  })();
  return {
    id: row.id,
    name: row.name,
    protocol: row.protocol as ProviderConfig["protocol"],
    baseUrl: row.baseUrl,
    maxClassification: row.maxClassification,
    credentialRef: credRow?.vaultRef,
    config,
  };
}

function csvFlag(flags: ReadonlyMap<string, string | true>, name: string): readonly string[] {
  const v = flagString(flags, name);
  if (v === undefined) return Object.freeze([]);
  return Object.freeze(v.split(",").map((x) => x.trim()).filter((x) => x !== ""));
}

async function readAllStdin(limitBytes = 64 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += b.length;
    if (size > limitBytes) throw new CliError("USAGE", `stdin exceeds ${limitBytes} byte cap`);
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// ---------------------------------------------------------------- agent transport
/** Offline replay transport: paragraphs separated by blank lines, '#' comments stripped. */
function scriptTransport(turns: readonly string[]): AgentTransport {
  let i = 0;
  return async (_messages: readonly AgentMessage[]) => {
    if (i >= turns.length) {
      throw new Error(`script exhausted at turn ${String(i + 1)} — add another paragraph to the script file`);
    }
    const content = turns[i] as string;
    i += 1;
    return { content };
  };
}

function parseScriptFile(path: string): readonly string[] {
  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n").filter((l: string) => !l.trimStart().startsWith("#"));
  return Object.freeze(
    lines
      .join("\n")
      .split(/\n[ \t]*\n+/)
      .map((p: string) => p.trim())
      .filter((p: string) => p !== ""),
  );
}

/** Provider-backed transport: dispatcher gates (egress, classification, secret scan, budget) hold. */
function providerTransport(
  s: Services,
  actor: string,
  providers: { providerId: string; modelId: string },
  contextClassification: DataClassification,
): AgentTransport {
  const config = configForProvider(s, providers.providerId);
  if (config.credentialRef === undefined) {
    throw new CliError("AUTH", `provider ${providers.providerId} has no credential (aice provider key set ...); local providers may still pass the dispatcher's egress/probe gates`);
  }
  return async (messages: readonly AgentMessage[]) => {
    const { dispatcher } = await makeDispatcher(s, actor);
    const chatMessages = messages.map((m) => ({
      role: m.role === "tool" ? ("user" as const) : m.role,
      content: m.role === "tool" ? `<<<TOOL-MESSAGE>>>\n${m.content}\n<<<END-TOOL-MESSAGE>>>` : m.content,
    }));
    const res = await dispatcher.complete(
      config,
      { model: providers.modelId, messages: chatMessages },
      { contextClassification },
    );
    return { content: res.content };
  };
}

type AgentRunPhase = "investigate" | "plan" | "implement";
const AGENT_PHASES: readonly AgentRunPhase[] = ["investigate", "plan", "implement"];

/** Phase → registered tool surface (policy gates still apply inside every executor). */
function registryForPhase(phase: AgentRunPhase): ToolRunner {
  switch (phase) {
    case "investigate":
      return new ToolRunner([...FS_TOOLS, ...GIT_TOOLS]);
    case "plan":
      return new ToolRunner([...FS_TOOLS, ...GIT_TOOLS]);
    case "implement":
      return new ToolRunner([...FS_TOOLS, ...TEST_RUNNER_TOOLS, ...GIT_TOOLS]);
  }
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
        return throwUsage("project create|list|archive");
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
        if (sub === "inspect") {
          const id = pos[1] ?? throwUsage("task inspect <id>");
          const t = s.tasks.get(id);
          const bundle = {
            task: t,
            runs: s.runs.listByTask(id),
            agentRuns: s.agentRuns.listByTask(id),
            testResults: s.testResults.byTask(id),
            findings: s.findings.byTask(id),
            audit: s.audit.listByTask(id),
          };
          if (out.json) {
            out.print(bundle, "");
          } else {
            console.log(`task ${t.id} [${t.state}] risk=${t.risk} class=${t.classification}`);
            console.log(`  ${t.title}`);
            console.log(`runs: ${bundle.runs.length} | agent runs: ${bundle.agentRuns.length} | test results: ${bundle.testResults.length} | findings: ${bundle.findings.length}`);
            for (const ar of bundle.agentRuns) {
              console.log(
                `  agent ${ar.phase} ${ar.status} rounds=${ar.rounds} tools=${ar.toolCalls} denials=${ar.denials} model=${ar.modelId ?? "—"} (${ar.createdAt})`,
              );
              if (ar.finalText !== null) console.log(`    final: ${ar.finalText.slice(0, 160).replace(/\n/g, " ")}`);
            }
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
        return throwUsage("task create|list|show|advance|fail");
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
        return throwUsage("workspace prepare|list|remove");
      }

      case "tests": {
        const sub = pos[0];
        if (sub !== "record") throwUsage("tests record <id> --suite S --passed N [--failed N] [--skipped N]");
        const id = pos[1] ?? throwUsage("tests record <id> --suite S --passed N");
        s.tasks.get(id);
        const suite = needFlag(global.flags, "suite");
        const passedRaw = needFlag(global.flags, "passed");
        const passed = Number(passedRaw);
        const failed = Number(flagString(global.flags, "failed") ?? "0");
        const skipped = Number(flagString(global.flags, "skipped") ?? "0");
        if (!Number.isInteger(passed) || passed < 0 || !/^[0-9]+$/.test(passedRaw)) {
          return throwUsage("--passed must be a non-negative integer");
        }
        if (!Number.isInteger(failed) || failed < 0 || !Number.isInteger(skipped) || skipped < 0) {
          return throwUsage("--failed/--skipped must be non-negative integers");
        }
        const row = s.testResults.add(id, { suite, passed, failed, skipped });
        s.audit.append({
          actor, action: "tests.recorded", target: id,
          taskId: id, decision: "allow",
          detail: { suite, passed, failed, skipped },
        });
        out.print({ id: row.id, taskId: id, suite, passed, failed, skipped }, `test evidence recorded: ${suite} +${passed} -${failed} (row ${row.id})`);
        return 0;
      }

      case "findings": {
        const sub = pos[0] ?? throwUsage("findings add|list|resolve");
        if (sub === "add") {
          const id = pos[1] ?? throwUsage("findings add <id> --severity S --rule R --summary T");
          s.tasks.get(id);
          const severity = enumFlag(global.flags, "severity", ["info", "low", "medium", "high", "critical"] as const);
          if (severity === undefined) throwUsage("--severity info|low|medium|high|critical required");
          const rule = needFlag(global.flags, "rule");
          const summary = needFlag(global.flags, "summary");
          const location = flagString(global.flags, "location") ?? null;
          const row = s.findings.add(id, { severity, ruleId: rule, location, summary });
          s.audit.append({
            actor, action: "finding.recorded", target: id,
            taskId: id, decision: "allow",
            detail: { severity, ruleId: rule, location },
          });
          out.print(
            { id: row.id, taskId: id, severity, ruleId: rule, location, status: row.status },
            `finding recorded: ${severity} ${rule}${location ? ` @ ${location}` : ""} (row ${row.id})`,
          );
          return 0;
        }
        if (sub === "list") {
          const id = pos[1] ?? throwUsage("findings list <id>");
          s.tasks.get(id);
          const rows = s.findings.byTask(id);
          const blockers = s.findings.openBlockers(id);
          out.print(
            { taskId: id, total: rows.length, openBlockers: blockers.length, rows },
            `findings for ${id}: total=${rows.length} openBlockers=${blockers.length}`,
          );
          return 0;
        }
        if (sub === "resolve") {
          const rowId = Number(pos[1] ?? throwUsage("findings resolve <rowId> --status S"));
          if (!Number.isInteger(rowId) || rowId <= 0) throwUsage("findings resolve <rowId> --status S");
          const status = enumFlag(global.flags, "status", ["open", "acknowledged", "fixed", "wontfix"] as const);
          if (status === undefined) throwUsage("--status open|acknowledged|fixed|wontfix required");
          const before = s.findings.byId(rowId);
          const after = s.findings.updateStatus(rowId, status);
          s.audit.append({
            actor, action: "finding.resolved", target: after.taskId,
            taskId: after.taskId, decision: "allow",
            detail: { rowId, from: before.status, to: status },
          });
          out.print({ id: rowId, taskId: after.taskId, from: before.status, to: status }, `finding ${rowId}: ${before.status} → ${status}`);
          return 0;
        }
        return throwUsage("findings add|list|resolve");
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


      case "provider": {
        const sub = pos[0];
        if (sub === "add") {
          const name = needFlag(global.flags, "name");
          const protocol = enumFlag(global.flags, "protocol", Object.keys(PROTOCOL_DEFAULT_BASE) as string[]);
          const baseUrl = flagString(global.flags, "base-url") ?? PROTOCOL_DEFAULT_BASE[protocol] ?? "";
          if (baseUrl === "") throw new CliError("USAGE", `protocol ${protocol} requires --base-url`);
          const maxClassification = enumFlag(global.flags, "max-classification", CLASSIFICATIONS, "internal" as DataClassification);
          const configJson = flagString(global.flags, "config-json");
          try {
            assertProviderEndpoint(baseUrl, protocol as ProviderConfig["protocol"]);
          } catch (err) {
            const code = err instanceof ProviderError ? err.code : "EGRESS_DENIED";
            throw new CliError(code, err instanceof Error ? err.message : "endpoint denied");
          }
          const pid = s.providers.upsert({ name, protocol, baseUrl, maxClassification, configJson });
          s.audit.append({ actor, action: "provider.upsert", target: pid, detail: { name, protocol, baseUrl, maxClassification } });
          out.print({ id: pid, name, protocol, baseUrl, maxClassification }, `provider ${pid} "${name}" (${protocol} @ ${baseUrl}) [${maxClassification}]`);
          return 0;
        }
        if (sub === "list") {
          const rows = s.providers.list();
          out.print(
            rows,
            rows
              .map((r) => `${r.id}\t${r.name}\t${r.protocol}\t${r.maxClassification}\t${r.enabled ? "enabled" : "disabled"}\t${r.baseUrl}`)
              .join("\n"),
          );
          return 0;
        }
        if (sub === "remove") {
          const id = pos[1] ?? throwUsage("provider remove <id>");
          if (s.providers.get(id) === undefined) throw new CliError("NOT_FOUND", `unknown provider: ${id}`);
          s.providers.remove(id); // credentials + models cascade (FK)
          s.audit.append({ actor, action: "provider.remove", target: id });
          out.print({ id }, `provider ${id} removed (credentials + models cascaded)`);
          return 0;
        }
        if (sub === "test") {
          const id = pos[1] ?? throwUsage("provider test <id>");
          const { dispatcher } = await makeDispatcher(s, actor);
          const report = await dispatcher.testConnection(configForProvider(s, id));
          out.print(
            report,
            report.ok
              ? `provider ${id}: OK (${report.modelsFound ?? 0} models, ${report.latencyMs}ms)`
              : `provider ${id}: FAIL — ${report.detail ?? "unreachable"}`,
          );
          return report.ok ? 0 : 1;
        }
        if (sub === "key") {
          const keyOp = pos[1];
          const id = pos[2] ?? throwUsage("provider key set|remove|status <provider-id>");
          s.providers.get(id);
          if (!/^[-\w.]+$/.test(id)) throw new CliError("USAGE", "provider id must be a safe slug (letters, digits, -, _, .)");
          const ref = `vault://providers/${id}/key`;
          if (keyOp === "set") {
            if (global.flags.get("stdin") !== true) {
              throw new CliError(
                "USAGE",
                "refusing to read a key anywhere but stdin — pipe it: echo '<key>' | aice provider key set <id> --stdin",
              );
            }
            if (flagString(global.flags, "value") !== undefined) {
              throw new CliError("USAGE", "--value would place the secret in argv (T5) — stdin only");
            }
            const raw = (await readAllStdin()).trim();
            if (raw === "") throw new CliError("USAGE", "stdin was empty — no key stored");
            const vaultSel = await detectVault();
            await vaultSel.vault.store(secretRef(ref), secretValue(raw));
            const last4 = last4Of(secretValue(raw));
            s.creds.set(id, ref, last4);
            s.audit.append({ actor, action: "provider.credential.set", target: id, detail: { ref, last4 } });
            out.print({ id, ref, last4, backend: vaultSel.kind }, `credential set for ${id} — backend: ${vaultSel.kind}, ref ${ref}, last4: ${last4}`);
            return 0;
          }
          if (keyOp === "remove") {
            const vaultSel = await detectVault();
            try {
              await vaultSel.vault.delete(secretRef(ref));
            } catch {
              // not present in the vault — still clear the DB pointer (idempotent)
            }
            s.creds.remove(id);
            s.audit.append({ actor, action: "provider.credential.remove", target: id });
            out.print({ id }, `credential removed for ${id}`);
            return 0;
          }
          if (keyOp === "status") {
            const credRow = s.creds.get(id);
            const payload = credRow === undefined ? { stored: false } : { stored: true, ref: credRow.vaultRef, last4: credRow.last4, updatedAt: credRow.updatedAt };
            out.print(payload, credRow === undefined ? `provider ${id}: no credential stored` : `provider ${id}: ref ${credRow.vaultRef} last4 ${credRow.last4} (updated ${credRow.updatedAt})`);
            return credRow === undefined ? 1 : 0;
          }
          return throwUsage("provider key set|remove|status <provider-id>");
        }
        return throwUsage("provider add|list|remove|test|key");
      }

      case "model": {
        const sub = pos[0];
        if (sub === "list") {
          const providerId = flagString(global.flags, "provider");
          const rows = providerId !== undefined ? s.models.listByProvider(providerId) : s.models.listAll();
          out.print(
            rows,
            rows.map((r) => `${r.id}\t${r.status}\tverified=${r.verified}\tcw=${r.contextWindow}\t${r.displayName}`).join("\n"),
          );
          return 0;
        }
        if (sub === "discover") {
          const id = pos[1] ?? throwUsage("model discover <provider-id>");
          const { dispatcher } = await makeDispatcher(s, actor);
          const report = await discoverIntoDb(configForProvider(s, id), dispatcher, s.models);
          s.audit.append({ actor, action: "model.discover", target: id, detail: { added: report.added, updated: report.updated, totalFound: report.totalFound } });
          out.print(report, `discover ${id}: ${report.totalFound} found (${report.added} added, ${report.updated} updated)`);
          return 0;
        }
        if (sub === "probe") {
          const providerId = flagString(global.flags, "provider");
          const targetId = pos[1];
          if (providerId === undefined && targetId === undefined) throwUsage("model probe <model-id> | model probe --provider ID");
          const { dispatcher } = await makeDispatcher(s, actor);
          const providerFor = targetId !== undefined ? (s.models.get(targetId)?.providerId ?? throwUsage("model probe <existing-model-id>")) : providerId;
          const reports = providerId !== undefined
            ? await probeAll(configForProvider(s, providerId as string), dispatcher, s.models)
            : [await probeModel(configForProvider(s, String(providerFor)), dispatcher, s.models, targetId as string)];
          const rows = reports.map((r) => ({ modelId: r.modelId, ok: r.ok, statusAfter: r.statusAfter, latencyMs: r.latencyMs, detail: r.detail ?? null }));
          out.print(
            rows,
            rows.map((r) => `${r.ok ? "PASS" : "FAIL"}\t${r.modelId}\t${r.statusAfter}\t${r.latencyMs}ms${r.detail ? `\t${r.detail}` : ""}`).join("\n"),
          );
          return rows.every((r) => r.ok) ? 0 : 1;
        }
        return throwUsage("model list|discover|probe");
      }

      case "budget": {
        const sub = pos[0];
        if (sub === "set") {
          const providerId = flagString(global.flags, "provider");
          const modelId = flagString(global.flags, "model");
          if ((providerId === undefined) === (modelId === undefined)) {
            throw new CliError("USAGE", "provide exactly one of --provider ID or --model ID");
          }
          const scope = providerId !== undefined ? "provider" : "model";
          const scopeId = (providerId ?? modelId) as string;
          const window = enumFlag(global.flags, "window", ["daily", "weekly", "monthly", "total"] as const);
          const limitUsd = flagString(global.flags, "usd");
          const limitIn = flagString(global.flags, "in");
          const limitOut = flagString(global.flags, "out");
          const id = s.budgets.set({
            scope,
            scopeId,
            window,
            limitUsd: limitUsd === undefined ? null : Number(limitUsd),
            limitTokensIn: limitIn === undefined ? null : Number(limitIn),
            limitTokensOut: limitOut === undefined ? null : Number(limitOut),
            hardBlock: true,
          });
          s.audit.append({ actor, action: "budget.set", target: id, detail: { scope, scopeId, window, limitUsd, limitIn, limitOut } });
          out.print(s.budgets.get(id), `budget ${id}: ${scope} ${scopeId} / ${window} (hard block)`);
          return 0;
        }
        if (sub === "list") {
          const rows = s.budgets.list();
          out.print(
            rows,
            rows
              .map((b) => `${b.id}\t${b.scope}:${b.scopeId}\t${b.window}\tusd=${b.limitUsd ?? "—"}\tin=${b.limitTokensIn ?? "—"}\tout=${b.limitTokensOut ?? "—"}`)
              .join("\n"),
          );
          return 0;
        }
        if (sub === "events") {
          const providerId = flagString(global.flags, "provider");
          const limit = flagString(global.flags, "limit");
          const rows = s.bEvents.listRecent({
            providerId,
            limit: limit === undefined ? undefined : Number(limit),
          });
          out.print(
            rows,
            rows
              .map(
                (e) =>
                  `#${e.id}\t${e.at}\t${e.providerId}\t${e.modelId ?? "—"}\tin=${e.tokensIn}\tout=${e.tokensOut}\t$${e.costUsd.toFixed(6)}\t${e.decision}${e.detail ? `\t${redact(e.detail).text}` : ""}`,
              )
              .join("\n"),
          );
          return 0;
        }
        if (sub === "remove") {
          const id = pos[1] ?? throwUsage("budget remove <id>");
          s.budgets.remove(id);
          s.audit.append({ actor, action: "budget.remove", target: id });
          out.print({ id }, `budget ${id} removed`);
          return 0;
        }
        return throwUsage("budget set|list|events|remove");
      }

      case "agent": {
        const sub = pos[0];
        if (sub === "list") {
          const rows = Object.values(BUILTIN_MANIFESTS).map((m) => ({
            agent: m.agent,
            description: m.description,
            toolsAllow: m.grant.toolsAllow,
            fsRead: m.grant.fsRead,
            fsWrite: m.grant.fsWrite,
            terminal: m.grant.terminal,
            maxRisk: m.grant.maxRisk,
          }));
          out.print(rows, rows.map((r) => `${r.agent}\t[${r.maxRisk}]\t${r.toolsAllow.join(",")}\t${r.description}`).join("\n"));
          return 0;
        }
        if (sub !== "run") return throwUsage("agent run <task-id> --phase P [--script-file F] [--rounds N] [--approved]");
        const taskId = pos[1] ?? throwUsage("agent run <task-id> --phase ...");
        const t = s.tasks.get(taskId);
        const project = s.projects.get(t.projectId);
        const phase = enumFlag(global.flags, "phase", AGENT_PHASES);
        const roundsRaw = flagString(global.flags, "rounds");
        const maxIterations = roundsRaw === undefined ? 12 : Number(roundsRaw);
        if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 64) {
          throw new CliError("USAGE", "--rounds must be an integer between 1 and 64");
        }
        const approved = global.flags.get("approved") === true;
        // Jail: latest ACTIVE isolated workspace for this task, else the project root.
        const ws = s.workspaces
          .listByProject(project.id)
          .filter((w) => w.taskId === taskId && w.state === "active")
          .at(-1);
        const jailRoot = ws !== undefined ? ws.path : project.rootPath;
        const policyCtx: PolicyContext = { workspaceLocked: false, providerMaxClassification: t.classification };

        const promptOverride = flagString(global.flags, "prompt");
        let modelLabel: string | undefined;
        let transport: AgentTransport;
        const scriptFile = flagString(global.flags, "script-file");
        if (scriptFile !== undefined) {
          transport = scriptTransport(parseScriptFile(scriptFile));
        } else {
          // Provider ids are not secrets (Plan §9): flags override env; keys stay in the vault.
          const providerId = flagString(global.flags, "provider") ?? process.env.AICE_AGENT_PROVIDER;
          const modelId = flagString(global.flags, "model") ?? process.env.AICE_AGENT_MODEL;
          if (providerId === undefined || modelId === undefined) {
            throw new CliError(
              "USAGE",
              "no transport configured: pass --script-file F, --provider/--model, or set AICE_AGENT_PROVIDER + AICE_AGENT_MODEL",
            );
          }
          modelLabel = `${providerId}/${modelId}`;
          transport = providerTransport(s, actor, { providerId, modelId }, t.classification);
        }

        const runner = registryForPhase(phase);
        const common = { runner, jailRoot, policyCtx, transport };
        const opts = { maxIterations, approved };
        interface FlowResult {
          status: AgentRunResult["status"];
          rounds: number;
          toolCalls: number;
          denials: number;
          readonly pendingApproval?: unknown;
          transcript: AgentRunResult["transcript"];
        }
        let result: FlowResult;
        let finalText: string | null;
        if (phase === "investigate") {
          const r = await investigate({ ...common, task: { title: promptOverride ?? t.title, risk: t.risk } }, opts);
          result = r;
          finalText = r.note;
        } else if (phase === "plan") {
          const note = s.agentRuns.latestByPhase(taskId, "investigate")?.finalText ?? "(no investigation note on record)";
          const r = await architectPlan({ ...common, task: { title: promptOverride ?? t.title, risk: t.risk, investigation: note }, approved }, opts);
          result = r;
          finalText = r.plan;
        } else {
          const planText = s.agentRuns.latestByPhase(taskId, "plan")?.finalText ?? "(no plan on record)";
          const r = await implement({ ...common, task: { title: promptOverride ?? t.title, plan: planText }, approved }, opts);
          result = r;
          finalText = r.summary;
        }

        const row = s.agentRuns.record({
          taskId,
          phase,
          ...(modelLabel !== undefined ? { modelId: modelLabel } : {}),
          status: result.status,
          rounds: result.rounds,
          toolCalls: result.toolCalls,
          denials: result.denials,
          transcriptJson: JSON.stringify(result.transcript),
          ...(finalText !== null ? { finalText } : {}),
        });
        // Artifact persistence under the jail's .aice/ (Plan §26: stored, never executed).
        const artifactDir = join(jailRoot, ".aice", "agent-runs");
        mkdirSync(artifactDir, { recursive: true });
        writeFileSync(join(artifactDir, `${row.id}.transcript.json`), JSON.stringify(result.transcript, null, 2) + "\n");
        if (finalText !== null) writeFileSync(join(artifactDir, `${row.id}.final.md`), finalText + "\n");
        const stateNow = t.state;
        s.runs.record({ taskId, agent: `agent:${phase}`, fromState: stateNow, toState: stateNow, modelId: modelLabel, summary: `${result.status} rounds=${result.rounds} denials=${result.denials}` });
        s.audit.append({
          actor: actor,
          action: `agent.run.${phase}`,
          target: taskId,
          projectId: project.id,
          taskId,
          decision: result.status === "completed" ? "allow" : "deny",
          detail: {
            status: result.status,
            jailRoot,
            rounds: result.rounds,
            toolCalls: result.toolCalls,
            denials: result.denials,
            model: modelLabel ?? "script-replay",
            approvedFlag: approved,
          },
        });
        const exitOk = result.status === "completed";
        out.print(
          { id: row.id, taskId, phase, status: result.status, rounds: result.rounds, toolCalls: result.toolCalls, denials: result.denials, jailRoot },
          [
            `agent ${phase} on task ${taskId}: ${result.status} (row ${row.id})`,
            `  jail: ${jailRoot}`,
            `  rounds: ${result.rounds}  tool calls: ${result.toolCalls}  denials: ${result.denials}`,
            ...(result.status === "awaiting-approval" ? ["  STALLED: approval gate — re-run with --approved after recording Plan §33 evidence"] : []),
            ...(finalText !== null ? ["", finalText] : []),
          ].join("\n"),
        );
        return exitOk ? 0 : 1;
      }

      case "context": {
        const sub = pos[0];
        if (sub !== "build") return throwUsage("context build <task-id> [--prompt T] [--budget N]");
        const taskId = pos[1] ?? throwUsage("context build <task-id> ...");
        const t = s.tasks.get(taskId);
        const project = s.projects.get(t.projectId);
        const ws = s.workspaces
          .listByProject(project.id)
          .filter((w) => w.taskId === taskId && w.state === "active")
          .at(-1);
        const jailRoot = ws !== undefined ? ws.path : project.rootPath;
        const taskText = flagString(global.flags, "prompt") ?? t.title;
        const budgetRaw = flagString(global.flags, "budget");
        const maxTokens = budgetRaw === undefined ? 8000 : Number(budgetRaw);
        if (!Number.isInteger(maxTokens) || maxTokens < 256 || maxTokens > 500000) {
          throw new CliError("USAGE", "--budget must be 256..500000");
        }
        const index = buildRepoIndex(jailRoot);
        const indexPath = persistRepoIndex(jailRoot, index);
        const pack = packWorkspace(jailRoot, index, { taskText, classification: t.classification }, maxTokens);
        const packPath = resolve(jailRoot, ".aice", "context", "pack.json");
        mkdirSync(resolve(jailRoot, ".aice", "context"), { recursive: true });
        writeFileSync(
          packPath,
          JSON.stringify(
            {
              taskId,
              taskText: taskText.slice(0, 200),
              jailRoot,
              budgetTokens: maxTokens,
              packed: pack.packed,
              dropped: pack.dropped,
              ranked: pack.ranked.slice(0, 25),
              redactionHits: pack.redactionHits,
            },
            null,
            1,
          ) + "\n",
        );
        s.audit.append({
          actor,
          action: "context.build",
          target: taskId,
          projectId: project.id,
          taskId,
          decision: "allow",
          detail: {
            filesIndexed: index.files.length,
            skipped: index.skipped.length,
            symbols: index.symbols.length,
            edges: index.edges.length,
            chunks: pack.packed.length,
            droppedChunks: pack.dropped.length,
            redactionHits: pack.redactionHits,
            jailRoot,
          },
        });
        out.print(
          { index: indexPath, pack: packPath, filesIndexed: index.files.length, symbols: index.symbols.length, edges: index.edges.length, chunks: pack.packed.length, dropped: pack.dropped.length, redactionHits: pack.redactionHits },
          [
            `context built for ${taskId} (jail ${jailRoot})`,
            `  files: ${index.files.length}  symbols: ${index.symbols.length}  edges: ${index.edges.length}  skipped: ${index.skipped.length}`,
            `  chunks packed: ${pack.packed.length} / dropped: ${pack.dropped.length}  (budget ${maxTokens} tok)  redactions: ${pack.redactionHits}`,
            `  index → ${indexPath}`,
            `  pack  → ${packPath}`,
          ].join("\n"),
        );
        return 0;
      }

      case "route": {
        const taskId = pos[0] ?? throwUsage("route <task-id> [--prompt T]");
        const t = s.tasks.get(taskId);
        const project = s.projects.get(t.projectId);
        const facts = classifyTask(flagString(global.flags, "prompt") ?? t.title);
        const decision = routeTask({
          task: facts,
          projectClassification: project.classification,
          models: s.models.listAll(),
          providers: s.providers.list(),
        });
        s.audit.append({
          actor,
          action: "route.decision",
          target: taskId,
          projectId: project.id,
          taskId,
          decision: "allow",
          detail: { kind: facts.kind, risk: facts.risk, rule: decision.rule, modelId: decision.modelId, providerId: decision.providerId },
        });
        const payload = { taskId, facts, decision };
        out.print(
          payload,
          [
            `task: kind=${facts.kind} risk=${facts.risk}${facts.mutating ? " mutating" : ""}${facts.codeIntensive ? " code" : ""}`,
            `route: ${decision.modelId} via ${decision.providerId}`,
            `rule: ${decision.rule}`,
            `candidates: ${decision.candidates.join(", ") || "—"}`,
            `rationale: ${decision.rationale}`,
          ].join("\n"),
        );
        return decision.modelId === "(none)" ? 1 : 0;
      }

      case "mcp": {
        const sub = pos[0];
        if (sub === "add") {
          const name = needFlag(global.flags, "name");
          const transport = enumFlag(global.flags, "transport", ["stdio", "http", "sse"] as const);
          const toolsAllow = csvFlag(global.flags, "tools-allow");
          const toolsDeny = csvFlag(global.flags, "tools-deny");
          const networkAllow = csvFlag(global.flags, "network-allow");
          const trust = enumFlag(global.flags, "trust", ["low", "medium", "high"] as const, "low");
          const audited = global.flags.get("audited") === true;
          const command = csvFlag(global.flags, "command");
          const url = flagString(global.flags, "url");
          const credentialRef = flagString(global.flags, "credential-ref");
          const mcpId = randomUUID();
          const cfg = {
            id: mcpId,
            name,
            transport,
            trust,
            toolsAllow,
            toolsDeny,
            resourcesAllow: Object.freeze([]),
            networkAllow,
            audited,
            ...(url !== undefined ? { url } : {}),
            ...(command.length > 0 ? { command } : {}),
            ...(credentialRef !== undefined ? { credentialRef } : {}),
          };
          // install-level validation BEFORE persistence (fail closed)
          const errors = validateMcpConfig(cfg);
          if (errors.length > 0) {
            out.err("CONFIG_INVALID", errors.join("; "));
            return 1;
          }
          const id = s.mcpServers.upsert({ id: mcpId, name, transport, trust, configJson: JSON.stringify(cfg) });
          s.audit.append({ actor, action: "mcp.add", target: id, decision: "allow", detail: { name, transport, trust, toolsAllow: toolsAllow.length, toolsDeny: toolsDeny.length, networkAllow, commandCount: command.length, urlHost: url !== undefined ? new URL(url).hostname : null } });
          out.print({ id, name, transport, trust }, `mcp server ${id} "${name}" (${transport}) trust=${trust} [validated]`);
          return 0;
        }
        if (sub === "list") {
          const rows = s.mcpServers.list();
          out.print(rows, rows.map((r) => `${r.id}\t${r.enabled ? "enabled" : "disabled"}\t${r.trust}\t${r.transport}\t${r.name}`).join("\n"));
          return 0;
        }
        if (sub === "remove") {
          const id = pos[1] ?? throwUsage("mcp remove <id>");
          const row = s.mcpServers.get(id);
          if (row === undefined) throw new CliError("NOT_FOUND", `unknown mcp server: ${id}`);
          s.mcpServers.remove(id);
          s.audit.append({ actor, action: "mcp.remove", target: id });
          out.print({ id }, `mcp server ${id} removed (permission rows cleaned)`);
          return 0;
        }
        if (sub === "enable" || sub === "disable") {
          const id = pos[1] ?? throwUsage(`mcp ${sub} <id>`);
          const row = s.mcpServers.get(id);
          if (row === undefined) throw new CliError("NOT_FOUND", `unknown mcp server: ${id}`);
          s.mcpServers.setEnabled(id, sub === "enable");
          s.audit.append({ actor, action: `mcp.${sub}`, target: id });
          out.print({ id, enabled: sub === "enable" }, `mcp server ${id} ${sub}d`);
          return 0;
        }
        if (sub === "invoke") {
          const id = pos[1] ?? throwUsage("mcp invoke <id> --tool T [--args-json J]");
          const row = s.mcpServers.get(id);
          if (row === undefined) throw new CliError("NOT_FOUND", `unknown mcp server: ${id}`);
          const tool = needFlag(global.flags, "tool");
          let args: unknown[] = [];
          const argsJson = flagString(global.flags, "args-json");
          if (argsJson !== undefined) {
            try {
              const a = JSON.parse(argsJson);
              if (!Array.isArray(a)) throw new Error("not-array");
              args = a;
            } catch {
              throw new CliError("USAGE", "--args-json must be a JSON array");
            }
          }
          let cfg;
          try {
            cfg = { ...JSON.parse(row.configJson), id: row.id };
          } catch {
            throw new CliError("INVALID_CONFIG", `mcp server ${id} config_json unreadable`);
          }
          const permRows = s.permissions.listFor(`mcp:${id}`);
          const decision = decideMcpCall({ server: cfg, enabled: row.enabled, permissionRows: permRows, tool, args });
          if (!decision.allowed) {
            s.audit.append({ actor, action: "mcp.invoke", target: id, decision: "deny", detail: { tool, code: decision.code, reason: decision.reason } });
            out.err(decision.code, `${decision.reason} (mcp ${id}, tool ${tool})`);
            return 1;
          }
          const res = await new McpClient({}).call(cfg, "tools/call", { name: tool, arguments: args });
          s.audit.append({ actor, action: "mcp.invoke", target: id, decision: res.ok ? "allow" : "deny", detail: { tool, lane: res.lane, ok: res.ok, error: res.error ?? null } });
          if (!res.ok) {
            out.err("MCP_TRANSPORT", res.error ?? "transport failed");
            return 1;
          }
          out.print({ ok: true, result: res.result }, `mcp ${id} tool=${tool} ok → ${JSON.stringify(res.result).slice(0, 400)}`);
          return 0;
        }
        return throwUsage("mcp add|list|remove|enable|disable|invoke");
      }

      case "skill": {
        const sub = pos[0];
        if (sub === "add") {
          const path = pos[1] ?? throwUsage("skill add <path>");
          const dir = resolve(path);
          if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new CliError("NOT_A_DIRECTORY", `skill path is not a dir: ${path}`);
          const d = digestSkillBundle(dir);
          if (d.error !== undefined) throw new CliError("BUNDLE_INVALID", d.error);
          const { manifest, errors } = parseSkillManifest(dir);
          if (errors.length > 0) throw new CliError("MANIFEST_INVALID", errors.join("; "));
          const mf = manifest as { name: string; version?: string; permissions: readonly string[] };
          const row = s.skills.register({
            name: mf.name,
            ...(mf.version !== undefined ? { version: mf.version } : {}),
            sourcePath: dir,
            sha256: d.sha256,
            permissionsJson: JSON.stringify(mf.permissions),
          });
          s.audit.append({ actor, action: "skill.add", target: row.id, decision: "allow", detail: { name: mf.name, digest: d.sha256, files: d.files.length, permissions: mf.permissions } });
          out.print(
            { id: row.id, name: mf.name, digest: d.sha256, status: row.status },
            `skill ${row.id} "${mf.name}" digest=${d.sha256.slice(0, 16)}… [${row.status}] — review before approve`,
          );
          return 0;
        }
        if (sub === "list") {
          const rows = s.skills.list();
          out.print(rows, rows.map((r) => `${r.id}\t${r.status}\t${r.name}\t${r.sha256.slice(0, 12)}`).join("\n"));
          return 0;
        }
        if (sub === "review") {
          const id = pos[1] ?? throwUsage("skill review <id>");
          const row = s.skills.get(id);
          if (row === undefined) throw new CliError("NOT_FOUND", `unknown skill: ${id}`);
          const perms = JSON.parse(row.permissionsJson) as string[];
          console.log(`skill ${row.id} ${row.name} v${row.version ?? "?"}`);
          console.log(`  path:    ${row.sourcePath}`);
          console.log(`  digest:  ${row.sha256}`);
          console.log(`  status:  ${row.status}${row.reviewedBy !== null ? ` by ${row.reviewedBy}` : ""}`);
          console.log("  declared permissions:");
          for (const p of perms) console.log(`    - ${p}`);
          if (perms.length === 0) console.log("    (none — read-only bundle)");
          console.log("  files are executed ONLY if this digest matches at gate time.");
          s.audit.append({ actor, action: "skill.review", target: id, decision: "allow" });
          return 0;
        }
        if (sub === "approve") {
          const id = pos[1] ?? throwUsage("skill approve <id>");
          const row = s.skills.get(id);
          if (row === undefined) throw new CliError("NOT_FOUND", `unknown skill: ${id}`);
          const live = digestSkillBundle(row.sourcePath);
          if (live.error !== undefined || live.sha256 !== row.sha256) {
            s.skills.setStatus(id, "blocked", actor);
            s.audit.append({ actor, action: "skill.tamper-block", target: id, decision: "deny", detail: { recorded: row.sha256, live: live.sha256, error: live.error ?? null } });
            out.err("TAMPER", `digest mismatch — skill ${id} BLOCKED (recorded ${row.sha256.slice(0, 12)} vs live ${live.sha256.slice(0, 12)})`);
            return 1;
          }
          s.skills.setStatus(id, "approved", actor);
          s.audit.append({ actor, action: "skill.approve", target: id, decision: "allow", detail: { digest: row.sha256 } });
          out.print({ id, status: "approved" }, `skill ${id} approved (digest ${row.sha256.slice(0, 12)} matches live)`);
          return 0;
        }
        if (sub === "gate") {
          const id = pos[1] ?? throwUsage("skill gate <id>");
          const row = s.skills.get(id);
          if (row === undefined) throw new CliError("NOT_FOUND", `unknown skill: ${id}`);
          const live = digestSkillBundle(row.sourcePath);
          const use = decideSkillUse(row.status, live.error !== undefined ? "" : live.sha256, row.sha256);
          if (!use.ok) {
            s.audit.append({ actor, action: "skill.gate", target: id, decision: "deny", detail: { status: row.status, reason: use.reason } });
            out.err("SKILL_GATE", use.reason);
            return 1;
          }
          s.audit.append({ actor, action: "skill.gate", target: id, decision: "allow", detail: { digest: row.sha256 } });
          out.print({ id, ok: true }, `skill ${id} usable (digest ${row.sha256.slice(0, 12)}, status approved)`);
          return 0;
        }
        return throwUsage("skill add|list|review|approve|gate");
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
