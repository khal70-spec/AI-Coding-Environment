// git.exec — Plan §18/§21 (P3.3). The ONLY git surface for agents: a thin,
// policy-jailed front over Phase-1 GitRunner. Agents pass subcommand argv
// (no leading "git"); the tool prepends it, then every Phase-1 guarantee holds:
// argv-only, destructive/blocklist shapes rejected pre-spawn, cwd pinned to the
// repo root, redacted output, GIT_TERMINAL_PROMPT=0.
//
// Policy mapping (preflight):
//   read-only subcommands (status/diff/log/show/rev-parse/ls-files) → risk low
//   mutating subcommands (commit/push/merge/checkout/stash/worktree/tag) → dangerous (approval)
//   classifier-blocked shapes (force-push, reset --hard, clean -fd) → neverAllow (deny)
import { classifyCommand } from "../../security/src/commands.ts";
import { GitRunner, GitSafetyError } from "../../git/src/runner.ts";
import { ToolError, type Tool } from "./runtime.ts";

const READ_ONLY_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "status", "diff", "log", "show", "rev-parse", "ls-files", "blame", "grep",
  "shortlog", "describe", "remote", "worktree",
]);

const MUTATING_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "commit", "push", "pull", "merge", "rebase", "cherry-pick", "revert",
  "checkout", "switch", "restore", "stash", "tag", "add",
]);

/** branch/worktree/remote/stash are read-only OR mutating depending on flags. */
function subcommandRisk(sub: string, rest: readonly string[]): "low" | "dangerous" {
  if (MUTATING_SUBCOMMANDS.has(sub)) return "dangerous";
  if (sub === "branch") {
    return rest.some((a) => /^-[dDmMf]/.test(a) || a === "--delete" || a === "--move") ? "dangerous" : "low";
  }
  if (sub === "worktree") {
    const action = rest.find((a) => !a.startsWith("-"));
    return action === "list" || action === undefined ? "low" : "dangerous";
  }
  if (sub === "remote") {
    const action = rest.find((a) => !a.startsWith("-"));
    return action === undefined || action === "-v" || action === "show" ? "low" : "dangerous";
  }
  if (sub === "stash") {
    const action = rest.find((a) => !a.startsWith("-"));
    return action === "list" || action === "show" || action === undefined ? "low" : "dangerous";
  }
  return READ_ONLY_SUBCOMMANDS.has(sub) ? "low" : "dangerous"; // unknown → conservative
}

export const gitExec: Tool = {
  id: "git.exec",
  description:
    "Run a git subcommand inside the repo jail via Phase-1 GitRunner (argv-only, redacted).",
  defaultRisk: "medium",
  argsSchema: {
    argv: { type: "string[]", required: true, maxItems: 32, maxLength: 256 },
  },
  preflight(args) {
    const argv = (args["argv"] as string[]) ?? [];
    if (argv.length === 0) {
      return { fsScope: "workspace", neverAllow: true, dangerous: true };
    }
    // Defense in depth: agents don't pass "git" itself; if they do, refuse clearly.
    if (argv[0] === "git") {
      return { fsScope: "workspace", neverAllow: true, dangerous: true };
    }
    const full = ["git", ...argv];
    const verdict = classifyCommand(full);
    if (verdict.risk === "blocked") {
      return { fsScope: "workspace", neverAllow: true, dangerous: true, riskOverride: "high" };
    }
    const subRisk = subcommandRisk(String(argv[0]), argv.slice(1));
    return {
      fsScope: "workspace",
      dangerous: subRisk === "dangerous",
      riskOverride: subRisk === "low" ? "low" : "medium",
    };
  },
  run(args, ctx) {
    const argv = ["git", ...((args["argv"] as string[]) ?? [])];
    const runner = new GitRunner(ctx.jailRoot);
    try {
      const res = runner.run(argv);
      const parts: string[] = [`git ${(args["argv"] as string[]).join(" ")}`];
      if (res.stdout.trim() !== "") parts.push(res.stdout.trim());
      if (res.stderr.trim() !== "") parts.push(`--- stderr ---\n${res.stderr.trim()}`);
      return parts.join("\n");
    } catch (err) {
      if (err instanceof GitSafetyError) {
        // Already redacted by the runner; re-map into the tool error vocabulary.
        throw new ToolError("EXECUTION_FAILED", `git ${err.code}: ${err.message}`);
      }
      throw new ToolError(
        "EXECUTION_FAILED",
        `git wrapper failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
};

export const GIT_TOOLS: readonly Tool[] = Object.freeze([gitExec]);
