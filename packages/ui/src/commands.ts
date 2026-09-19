// Bridge command registry (P7.1) — the UI allowlist. Each entry: explicit id,
// pinned args, handler over the real services (storage DAOs + TaskEngine). Mutations
// travel through the ENGINE (state invariants never bypassed); audits are
// content-free. Anything not listed here is structurally unreachable from the UI.
import type {
  ProjectsDao,
  TasksDao,
  RunsDao,
  WorkspacesDao,
  AuditDao,
  AgentRunsDao,
  TestResultsDao,
  FindingsDao,
  McpServersDao,
  SkillsDao,
} from "../../storage/src/index.ts";
import type { TaskEngine } from "../../orchestrator/src/index.ts";
import type { RiskLevel, DataClassification, TaskState } from "../../core/src/index.ts";
import { redact } from "../../security/src/index.ts";
import { GitRunner } from "../../git/src/runner.ts";
import { BridgeRegistry, type BridgeCommand } from "./bridge.ts";

export interface UiServices {
  readonly actor: string;
  readonly projects: ProjectsDao;
  readonly tasks: TasksDao;
  readonly runs: RunsDao;
  readonly workspaces: WorkspacesDao;
  readonly audit: AuditDao;
  readonly agentRuns: AgentRunsDao;
  readonly testResults: TestResultsDao;
  readonly findings: FindingsDao;
  readonly mcpServers: McpServersDao;
  readonly skills: SkillsDao;
  readonly engine: TaskEngine;
}

const ID = { type: "string", required: true, max: 64, pattern: /^[\w.-]{1,64}$/ } as const;
const CLASS = { type: "string", enum: ["public", "internal", "confidential", "restricted"] } as const;

/** Redact + truncate model/tool text before it ever lands on a UI surface. */
function display(text: string | null, max = 4000): string | null {
  if (text === null) return null;
  return redact(text.slice(0, max)).text;
}

export function buildBridge(): BridgeRegistry<UiServices> {
  const commands: readonly BridgeCommand<UiServices>[] = [
    {
      id: "projects.list",
      args: {},
      run: (s) => s.projects.list(),
    },
    {
      id: "projects.create",
      args: {
        name: { type: "string", required: true, max: 200 },
        rootPath: { type: "string", required: true, max: 500 },
        classification: CLASS,
      },
      run: (s, a) => {
        const p = s.projects.create({
          name: a["name"] as string,
          rootPath: a["rootPath"] as string,
          classification: (a["classification"] ?? "internal") as DataClassification,
        });
        s.audit.append({ actor: s.actor, action: "ui.project.create", target: p.id, projectId: p.id });
        return p;
      },
    },
    {
      id: "tasks.list",
      args: { projectId: ID },
      run: (s, a) => {
        s.projects.get(a["projectId"] as string); // existence (never cross-project)
        return s.tasks.listByProject(a["projectId"] as string);
      },
    },
    {
      id: "tasks.create",
      args: { projectId: ID, title: { type: "string", required: true, max: 2000 }, risk: { type: "string", enum: ["low", "medium", "high"] }, classification: CLASS },
      run: (s, a) => {
        const t = s.tasks.create({
          projectId: a["projectId"] as string,
          title: a["title"] as string,
          risk: (a["risk"] ?? "medium") as RiskLevel,
          classification: (a["classification"] ?? "internal") as DataClassification,
        });
        s.audit.append({ actor: s.actor, action: "ui.task.create", target: t.id, projectId: t.projectId, taskId: t.id });
        return t;
      },
    },
    {
      id: "tasks.show",
      args: { taskId: ID },
      run: (s, a) => {
        const t = s.tasks.get(a["taskId"] as string);
        return {
          task: t,
          project: s.projects.get(t.projectId),
          runs: s.runs.listByTask(t.id),
          workspaces: s.workspaces.listByProject(t.projectId).filter((w) => w.taskId === t.id),
        };
      },
    },
    {
      id: "tasks.diff",
      args: { taskId: ID },
      run: (s, a) => {
        const t = s.tasks.get(a["taskId"] as string);
        const project = s.projects.get(t.projectId);
        // Project-scoped: workspaces come from the task's own project lane.
        const ws = s.workspaces.listByProject(t.projectId).filter((w) => w.taskId === t.id).at(-1);
        if (ws === undefined) {
          return { task: t, workspace: null, stat: "", patch: "" };
        }
        // Runner rooted in the task worktree; `git diff <baseSha>` = base → working
        // tree in one pass (committed rounds + uncommitted edits), argv-only.
        const runner = new GitRunner(ws.path.startsWith("/") ? ws.path : `${project.rootPath}/${ws.path}`);
        const stat = runner.run(["git", "diff", "--stat", ws.baseSha]).stdout;
        const patch = display(runner.run(["git", "diff", ws.baseSha]).stdout, 30000) ?? "";
        s.audit.append({ actor: s.actor, action: "ui.task.diff", target: t.id, projectId: t.projectId, taskId: t.id });
        return { task: t, workspace: ws, stat, patch };
      },
    },
    {
      id: "tasks.bundle",
      args: { taskId: ID },
      run: (s, a) => {
        const t = s.tasks.get(a["taskId"] as string);
        const agentRuns = s.agentRuns.listByTask(t.id).map((r) => ({
          ...r,
          finalText: display(r.finalText, 2000),
          transcriptJson: display(r.transcriptJson, 20000), // transcripts: display-only
        }));
        return {
          task: t,
          runs: s.runs.listByTask(t.id),
          agentRuns,
          testResults: s.testResults.byTask(t.id),
          findings: s.findings.byTask(t.id),
          audit: s.audit.listByTask(t.id),
        };
      },
    },
    {
      id: "tasks.advance",
      args: { taskId: ID, to: { type: "string", max: 40 } },
      run: async (s, a) => {
        const r = await s.engine.transition({
          taskId: a["taskId"] as string,
          ...(a["to"] !== undefined ? { to: a["to"] as TaskState } : {}),
          actor: s.actor,
        });
        if (!r.ok) throw new Error(`ENGINE_${r.error.code}: ${r.error.message.slice(0, 200)}`);
        return r.value;
      },
    },
    {
      id: "tasks.fail",
      args: {
        taskId: ID,
        to: { type: "string", enum: ["BLOCKED", "CANCELLED", "FAILED", "ROLLBACK_REQUIRED"], required: true },
        reason: { type: "string", max: 300 },
      },
      run: async (s, a) => {
        const r = await s.engine.transition({ taskId: a["taskId"] as string, to: a["to"] as TaskState, actor: s.actor });
        if (!r.ok) throw new Error(`ENGINE_${r.error.code}: ${r.error.message.slice(0, 200)}`);
        return r.value;
      },
    },
    {
      id: "approvals.record",
      args: { taskId: ID, kind: { type: "string", enum: ["plan", "final"], required: true } },
      run: (s, a) => {
        s.tasks.get(a["taskId"] as string);
        s.engine.approve(a["taskId"] as string, a["kind"] as "plan" | "final", s.actor);
        return { recorded: true, kind: a["kind"] };
      },
    },
    {
      id: "agents.sessions",
      args: { taskId: ID },
      run: (s, a) =>
        s.agentRuns.listByTask(a["taskId"] as string).map((r) => ({
          ...r,
          transcriptJson: display(r.transcriptJson, 20000),
          finalText: display(r.finalText, 4000),
        })),
    },
    {
      id: "audit.list",
      args: { taskId: ID, limit: { type: "integer", max: 500 } },
      run: (s, a) => {
        const rows = s.audit.listByTask(a["taskId"] as string);
        return rows.slice(-((a["limit"] as number | undefined) ?? 100)).map((ev) => ({
          ...ev,
          detailText: display(JSON.stringify(ev.detail ?? {}), 2000),
        }));
      },
    },
    {
      id: "mcp.list",
      args: {},
      run: (s) => s.mcpServers.list().map((r) => ({ ...r, configJson: display(r.configJson, 3000) })),
    },
    {
      id: "mcp.toggle",
      args: { id: ID, enabled: { type: "boolean", required: true } },
      run: (s, a) => {
        const row = s.mcpServers.get(a["id"] as string);
        if (row === undefined) throw new Error(`mcp not found: ${a["id"] as string}`);
        s.mcpServers.setEnabled(a["id"] as string, a["enabled"] as boolean);
        s.audit.append({ actor: s.actor, action: `ui.mcp.${(a["enabled"] as boolean) ? "enable" : "disable"}`, target: a["id"] as string });
        return { enabled: a["enabled"] };
      },
    },
    {
      id: "skills.list",
      args: {},
      run: (s) => s.skills.list(),
    },
    {
      id: "skills.reviewLogged",
      args: { id: ID },
      run: (s, a) => {
        const row = s.skills.get(a["id"] as string);
        if (row === undefined) throw new Error(`skill not found: ${a["id"] as string}`);
        s.audit.append({ actor: s.actor, action: "ui.skill.review", target: a["id"] as string });
        return { logged: true };
      },
    },
  ];
  return new BridgeRegistry<UiServices>(commands);
}
