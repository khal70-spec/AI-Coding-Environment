// GitRunner — Plan §18/§21, ADR-004. The ONLY way git is executed in this codebase.
// Guarantees on every call:
//   1. argv[] only — shell strings are rejected (no shell is ever spawned);
//   2. argv[0] must be "git" and must survive isDestructiveGitArgs + the command
//      classifier BEFORE any process is spawned (blocked shapes never execute);
//   3. cwd is pinned to the runner's repo root (realpath-resolved at construction);
//   4. stdout/stderr are redacted before returning (secrets never enter logs);
//   5. no prompting: GIT_TERMINAL_PROMPT=0 — credential prompts fail closed instead.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { classifyCommand } from "../../security/src/commands.ts";
import { redact } from "../../security/src/redact.ts";
import { assertContainedSync } from "../../security/src/paths.ts";
import {
  cmdCurrentBranch,
  cmdCurrentSha,
  cmdStatus,
  cmdWorktreeAdd,
  cmdWorktreeCheckoutBranch,
  cmdWorktreeList,
  cmdWorktreeRemove,
  isDestructiveGitArgs,
} from "./index.ts";

export type GitErrorCode = "NOT_ARGV" | "NOT_GIT" | "PATH_ESCAPE" | "BLOCKED_COMMAND" | "EXEC_FAILED";

export class GitSafetyError extends Error {
  readonly code: GitErrorCode;
  constructor(code: GitErrorCode, message: string) {
    super(message);
    this.name = "GitSafetyError";
    this.code = code;
  }
}

export interface GitRunResult {
  readonly stdout: string; // redacted
  readonly stderr: string; // redacted
  readonly redactedKinds: readonly string[];
}

export interface Checkpoint {
  readonly sha: string;
  readonly branch: string;
  readonly dirty: boolean;
  /** Redacted `git status --porcelain=v1 -b` output. */
  readonly status: string;
}

const MAX_BUFFER = 16 * 1024 * 1024;

export class GitRunner {
  readonly root: string;

  constructor(root: string) {
    // Pin cwd to the real repo root — symlink escapes resolved once, at construction.
    this.root = realpathSync(root);
  }

  /**
   * Execute one argv. Throws GitSafetyError for any non-git, destructive, or
   * blocked-classified argv BEFORE spawning. Never throws on git's own failures
   * with code EXEC_FAILED carrying the redacted stderr — callers decide policy.
   */
  run(argv: readonly string[]): GitRunResult {
    if (!Array.isArray(argv) || argv.some((a) => typeof a !== "string")) {
      throw new GitSafetyError("NOT_ARGV", "git runner accepts argv arrays only — never raw shell strings");
    }
    if (argv[0] !== "git") {
      throw new GitSafetyError("NOT_GIT", `argv[0] must be "git", got: ${String(argv[0])}`);
    }
    const destructive = isDestructiveGitArgs(argv);
    if (destructive.destructive) {
      throw new GitSafetyError("BLOCKED_COMMAND", `destructive git argv denied: ${destructive.reason ?? "unknown"}`);
    }
    const verdict = classifyCommand(argv);
    if (verdict.risk === "blocked") {
      throw new GitSafetyError("BLOCKED_COMMAND", `classifier blocked argv: ${verdict.reasons.join("; ")}`);
    }
    const stdout = ((): string => {
      try {
        return execFileSync("git", argv.slice(1), {
          cwd: this.root,
          encoding: "utf8",
          maxBuffer: MAX_BUFFER,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err) {
        const e = err as { status?: number; stdout?: string; stderr?: string; message?: string };
        const rErr = redact(e.stderr ?? e.message ?? "git failed");
        const rOut = redact(e.stdout ?? "");
        throw new GitSafetyError(
          "EXEC_FAILED",
          `git exited ${String(e.status ?? "?")}: ${rErr.text.trim().slice(0, 500)}${rOut.text.trim() === "" ? "" : ` | stdout: ${rOut.text.trim().slice(0, 200)}`}`,
        );
      }
    })();
    const rOut = redact(stdout);
    return {
      stdout: rOut.text,
      stderr: "",
      redactedKinds: Object.freeze([...rOut.hits]),
    };
  }

  /**
   * Like run(), but non-zero exits in `acceptable` return the result instead of
   * throwing (for intentional multi-exit tools like merge-tree: 0=clean, 1=conflict).
   * Same argv-only/safety/classifier/redaction discipline; stderr always redacted.
   */
  runAllowExit(argv: readonly string[], acceptable: readonly number[]): GitRunResult & { readonly status: number } {
    if (!Array.isArray(argv) || argv.some((a) => typeof a !== "string")) {
      throw new GitSafetyError("NOT_ARGV", "git runner accepts argv arrays only — never raw shell strings");
    }
    if (argv[0] !== "git") {
      throw new GitSafetyError("NOT_GIT", `argv[0] must be "git", got: ${String(argv[0])}`);
    }
    const destructive = isDestructiveGitArgs(argv);
    if (destructive.destructive) {
      throw new GitSafetyError("BLOCKED_COMMAND", `destructive git argv denied: ${destructive.reason ?? "unknown"}`);
    }
    const verdict = classifyCommand(argv);
    if (verdict.risk === "blocked") {
      throw new GitSafetyError("BLOCKED_COMMAND", `classifier blocked argv: ${verdict.reasons.join("; ")}`);
    }
    try {
      const out = execFileSync("git", argv.slice(1), {
        cwd: this.root, encoding: "utf8", maxBuffer: MAX_BUFFER,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, stdio: ["ignore", "pipe", "pipe"],
      });
      const ro = redact(out);
      return { stdout: ro.text, stderr: "", redactedKinds: Object.freeze([...ro.hits]), status: 0 };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string; message?: string };
      const status = typeof e.status === "number" ? e.status : -1;
      if (!acceptable.includes(status)) {
        const rErr = redact(e.stderr ?? e.message ?? "git failed");
        throw new GitSafetyError("EXEC_FAILED", `git exited ${String(status)}: ${rErr.text.trim().slice(0, 500)}`);
      }
      const ro = redact(e.stdout ?? "");
      const re = redact(e.stderr ?? "");
      return { stdout: ro.text, stderr: re.text, redactedKinds: Object.freeze([...ro.hits, ...re.hits]), status };
    }
  }

  /** True when root is inside a git work tree. */
  isInsideWorkTree(): boolean {
    try {
      const r = this.run(["git", "rev-parse", "--is-inside-work-tree"]);
      return r.stdout.trim() === "true";
    } catch {
      return false;
    }
  }

  /** Read-only checkpoint: SHA + branch + dirty state. Never mutates anything. */
  checkpoint(): Checkpoint {
    const status = this.run(cmdStatus()).stdout;
    const lines = status.split("\n").filter((l) => l.trim() !== "");
    const workLines = lines.filter((l) => !l.startsWith("##"));
    return {
      sha: this.run(cmdCurrentSha()).stdout.trim(),
      branch: this.run(cmdCurrentBranch()).stdout.trim(),
      dirty: workLines.length > 0,
      status,
    };
  }

  /** Assert a path is contained inside the repo root (symlink-aware) or throw. */
  private assertPathInside(path: string): string {
    const r = assertContainedSync(this.root, path);
    if (!r.ok) throw new GitSafetyError("PATH_ESCAPE", r.error.message);
    return r.path;
  }

  /** `git worktree add --detach <path> <baseSha>` — path must live inside the root. */
  worktreeAdd(path: string, baseSha: string): GitRunResult {
    return this.run(cmdWorktreeAdd(this.assertPathInside(path), baseSha));
  }

  /** `git -C <path> checkout -b <branch>` — creates the task branch in the worktree. */
  worktreeCheckoutBranch(path: string, branch: string): GitRunResult {
    return this.run(cmdWorktreeCheckoutBranch(this.assertPathInside(path), branch));
  }

  worktreeList(): GitRunResult {
    return this.run(cmdWorktreeList());
  }

  worktreeRemove(path: string): GitRunResult {
    return this.run(cmdWorktreeRemove(this.assertPathInside(path)));
  }
}
