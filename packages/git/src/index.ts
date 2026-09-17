// @ai-coding-env/git — Plan §21, ADR-004. Phase 0: pure command builders + guards.
// Execution (spawn, worktree lifecycle) lands in Phase 1 behind the policy engine.
// Builders return argv[] — never shell strings.

export const DEFAULT_PROTECTED_BRANCHES: readonly string[] = Object.freeze(["main", "master", "production", "release"]);

export function isProtectedBranch(branch: string, protectedList: readonly string[] = DEFAULT_PROTECTED_BRANCHES): boolean {
  const b = branch.trim();
  return protectedList.some((p) => {
    if (p.endsWith("*")) return b.startsWith(p.slice(0, -1));
    return b === p;
  });
}

export function taskBranchName(taskId: string): string {
  const slug = taskId.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  if (slug.length === 0) throw new Error("task id produces empty branch slug");
  return `agent/${slug}`;
}

/** argv[] builders — ordered checkpoint flow per Plan §21. */
export function cmdStatus(): readonly string[] {
  return ["git", "status", "--porcelain=v1", "-b"];
}
export function cmdDiffStat(): readonly string[] {
  return ["git", "diff", "--stat"];
}
export function cmdCurrentSha(): readonly string[] {
  return ["git", "rev-parse", "HEAD"];
}
export function cmdCurrentBranch(): readonly string[] {
  return ["git", "rev-parse", "--abbrev-ref", "HEAD"];
}
export function cmdWorktreeAdd(worktreePath: string, baseSha: string): readonly string[] {
  return ["git", "worktree", "add", "--detach", worktreePath, baseSha];
}
export function cmdWorktreeCheckoutBranch(worktreePath: string, branch: string): readonly string[] {
  return ["git", "-C", worktreePath, "checkout", "-b", branch];
}
export function cmdWorktreeRemove(worktreePath: string): readonly string[] {
  return ["git", "worktree", "remove", "--force", worktreePath];
}
export function cmdWorktreeList(): readonly string[] {
  return ["git", "worktree", "list", "--porcelain"];
}

/** Reject destructive git argv before it ever reaches the policy engine's executor. */
export function isDestructiveGitArgs(argv: readonly string[]): { destructive: boolean; reason?: string } {
  if (argv[0] !== "git") return { destructive: false };
  const joined = argv.join(" ");
  if (/push\s+.*(--force|-f\b)/.test(joined)) return { destructive: true, reason: "force-push" };
  if (/push\s+.*--delete/.test(joined)) return { destructive: true, reason: "remote branch deletion" };
  if (/reset\s+--hard/.test(joined)) return { destructive: true, reason: "reset --hard" };
  if (/clean\s+-[a-z]*f/.test(joined) && /clean\s+-[a-z]*d/.test(joined)) {
    return { destructive: true, reason: "clean -fd" };
  }
  if (/branch\s+-[D]/.test(joined)) return { destructive: true, reason: "branch -D" };
  if (/stash\s+clear/.test(joined)) return { destructive: true, reason: "stash clear" };
  return { destructive: false };
}

/** Pushing is allowed only to non-protected task branches after verify + approval. */
export function mayPushToBranch(branch: string, verified: boolean, approved: boolean): boolean {
  if (isProtectedBranch(branch)) return false; // protected branches merge via review, never direct push
  return verified && approved;
}
