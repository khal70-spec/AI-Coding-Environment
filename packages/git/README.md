# `@ai-coding-env/git`

Git safety layer (Plan §21, ADR-004). Two halves:

- **`src/index.ts`** — pure argv builders + policy helpers (no execution): checkpoint /
  worktree / status command arrays (never shell strings), protected-branch rules,
  `isDestructiveGitArgs`, `mayPushToBranch`, task-branch naming.
- **`src/runner.ts`** — `GitRunner`, the ONLY git executor in the codebase:
  argv-only `execFile` (raw shell strings rejected), cwd pinned to the realpath of the
  repo root, destructive/blocked argv thrown **before** any spawn
  (`GitSafetyError: NOT_ARGV | NOT_GIT | PATH_ESCAPE | BLOCKED_COMMAND`), every
  stdout/stderr redacted before returning, `GIT_TERMINAL_PROMPT=0` (fail closed, never
  prompt). Worktree paths are containment-checked (symlink-aware) against the repo root.

Checkpoint = read-only evidence (SHA + branch + dirty state); it never modifies the
user's tree. Tests: `tests/unit/git/runner.test.mjs`, security suites
(`workspace-isolation`, `command-injection`).
