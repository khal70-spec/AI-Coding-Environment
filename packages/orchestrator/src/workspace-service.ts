// WorkspaceService — Plan §5/§21, ADR-004. Task workspaces are isolated git worktrees
// on task branches under <project>/.aice/worktrees/, created only after the plan
// approval gate passes and a checkpoint SHA is recorded. Fail closed: any failure
// audits the attempt and moves the task to BLOCKED — never leaves a half-prepared task.
import type { Result } from "../../core/src/index.ts";
import { fail, ok } from "../../core/src/index.ts";
import { assertContainedSync } from "../../security/src/paths.ts";
import { taskBranchName } from "../../git/src/index.ts";
import { GitRunner, GitSafetyError } from "../../git/src/runner.ts";
import type { WorkspacesDao, ProjectsDao, WorkspaceRow } from "../../storage/src/index.ts";
import type { TaskEngine, EngineDeps } from "./engine.ts";

export interface WorkspaceDeps extends EngineDeps {
  readonly projects: ProjectsDao;
  readonly workspaces: WorkspacesDao;
}

export class WorkspaceService {
  private readonly deps: WorkspaceDeps;
  private readonly engine: TaskEngine;
  constructor(deps: WorkspaceDeps, engine: TaskEngine) {
    this.deps = deps;
    this.engine = engine;
  }

  /**
   * Guarded preparation: transition → PREPARING_WORKSPACE (plan approval gate),
   * checkpoint the base SHA, create the isolated worktree + task branch, record the
   * workspace row. Any failure: audited + task BLOCKED (fail closed).
   */
  prepare(taskId: string, actor: string): Result<WorkspaceRow> {
    const task = this.deps.tasks.get(taskId);
    const block = (reason: string): Result<WorkspaceRow> => {
      this.deps.audit.append({
        actor,
        action: "workspace.prepare.failed",
        target: taskId,
        projectId: task.projectId,
        taskId,
        decision: "deny",
        detail: { reason },
      });
      this.engine.transition({ taskId, to: "BLOCKED", actor });
      return fail("WORKSPACE_PREPARE_FAILED", reason, "Resolve the blocker, then re-run prepare (task is BLOCKED and resumable).");
    };

    // Advance the read-only investigation phases up to the approval gate. Every step
    // is still individually guarded + audited by the engine. A task already in
    // PREPARING_WORKSPACE (resume after a previous partial prepare) skips the gate.
    const INVESTIGATION_PHASES: readonly string[] = ["CREATED", "CLASSIFYING", "INVESTIGATING", "PLANNING"];
    for (;;) {
      const cur = this.deps.tasks.get(taskId).state;
      if (cur === "WAITING_APPROVAL" || cur === "PREPARING_WORKSPACE") break;
      if (!INVESTIGATION_PHASES.includes(cur)) {
        return block(`task is in ${cur}; prepare requires the investigation/planning phases first`);
      }
      const step = this.engine.transition({ taskId, actor });
      if (!step.ok) {
        return block(`could not advance "${cur}" toward preparation: ${step.error.message}`);
      }
    }

    if (this.deps.tasks.get(taskId).state !== "PREPARING_WORKSPACE") {
      const gate = this.engine.transition({ taskId, to: "PREPARING_WORKSPACE", actor });
      if (!gate.ok) return fail(gate.error.code, gate.error.message, gate.error.remediation);
    }

    let project;
    try {
      project = this.deps.projects.get(task.projectId);
    } catch {
      return block(`project not found: ${task.projectId}`);
    }
    let runner: GitRunner;
    try {
      runner = new GitRunner(project.rootPath);
    } catch {
      return block(`project root is not readable: ${project.rootPath}`);
    }
    if (!runner.isInsideWorkTree()) {
      return block(`project root is not a git repository: ${project.rootPath}`);
    }
    // The worktree always branches off the recorded base SHA; the user's checked-out
    // branch (protected or not) is never modified (Plan §21, ADR-004).
    let checkpoint;
    try {
      checkpoint = runner.checkpoint();
    } catch (err) {
      return block(`checkpoint failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.engine.recordCheckpoint(taskId, checkpoint, actor);

    const slug = taskId.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "task";
    const worktreeRel = `.aice/worktrees/${slug}-${Date.now().toString(36)}`;
    const contained = assertContainedSync(project.rootPath, worktreeRel);
    if (!contained.ok) return block(`worktree path escapes project root: ${worktreeRel}`);

    const branch = taskBranchName(taskId);
    try {
      runner.worktreeAdd(contained.path, checkpoint.sha);
      runner.worktreeCheckoutBranch(contained.path, branch);
    } catch (err) {
      const msg = err instanceof GitSafetyError ? `${err.code}: ${err.message}` : String(err);
      return block(`worktree creation failed: ${msg}`);
    }
    const ws = this.deps.workspaces.create({
      projectId: project.id,
      taskId,
      path: contained.path,
      branch,
      baseSha: checkpoint.sha,
    });
    this.deps.audit.append({
      actor,
      action: "workspace.prepare",
      target: ws.id,
      projectId: project.id,
      taskId,
      decision: "allow",
      detail: { path: ws.path, branch: ws.branch, baseSha: ws.baseSha, dirty: checkpoint.dirty },
    });
    return ok(ws);
  }

  /** Remove a workspace's worktree (guarded argv) and mark the row removed. */
  remove(workspaceId: string, actor: string): Result<true> {
    const ws = this.deps.workspaces.get(workspaceId);
    const project = this.deps.projects.get(ws.projectId);
    try {
      new GitRunner(project.rootPath).worktreeRemove(ws.path);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.deps.audit.append({
        actor,
        action: "workspace.remove.failed",
        target: workspaceId,
        projectId: ws.projectId,
        decision: "deny",
        detail: { reason: msg },
      });
      return fail("WORKSPACE_REMOVE_FAILED", msg);
    }
    this.deps.workspaces.setState(workspaceId, "removed");
    this.deps.audit.append({
      actor,
      action: "workspace.remove",
      target: workspaceId,
      projectId: ws.projectId,
      taskId: ws.taskId ?? undefined,
      decision: "allow",
      detail: { path: ws.path },
    });
    return ok(true);
  }
}


