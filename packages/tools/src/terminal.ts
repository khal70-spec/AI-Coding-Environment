// terminal.exec — the ONLY path from agents to process execution (Plan §18, §23; threat T10).
//
// Sandbox level 1 guarantees, all enforced here:
//   * argv-only spawn (never a shell string) — no pipes, no globbing, no backticks
//     expansion, no `$(...)`; each argv element is literal data to execve(2).
//   * argv[0] is a bare executable name: no "/", no "..", must not be a shell or a
//     script interpreter running inline eval flags (-e/-c/--eval).
//   * cwd jailed inside the workspace (deepest-existing-ancestor realpath proof).
//   * sanitized environment: explicit allowlist only; HOME points AT the jail, not
//     the operator's home; no inherited secrets (no tokens, no SSH agent vars).
//   * stdin is "ignore" — the child can never block on or exfiltrate via our TTY.
//   * detached process group; on timeout/overflow we kill the whole group
//     (SIGTERM, then SIGKILL) so grandchildren die too.
//   * stdout+stderr captured and byte-capped; the runner adds redaction + trust tagging.
//
// Policy wiring: the command classifier verdict maps to preflight hints —
//   blocked  → neverAllow (hard deny, even operator-approved requests)
//   high     → dangerous (approval) + risk "high"
//   medium   → risk override "medium"
//   low      → risk override "low"
import { spawn } from "node:child_process";
import { relative } from "node:path";
import { classifyCommand } from "../../security/src/commands.ts";
import { assertContainedSync } from "../../security/src/paths.ts";
import { ToolError, type Tool } from "./runtime.ts";

export const TERMINAL_MAX_OUTPUT_BYTES = 256 * 1024;
export const TERMINAL_DEFAULT_TIMEOUT_MS = 120_000;
export const TERMINAL_MAX_TIMEOUT_MS = 600_000;

const SHELL_NAMES = new Set([
  "sh", "bash", "zsh", "dash", "fish", "csh", "tcsh", "ksh",
  "powershell", "pwsh", "cmd", "command.com",
]);

/** Interpreters that turn a flag into arbitrary source → eval shapes are never allowed. */
const EVAL_INTERPRETERS = new Set([
  "node", "nodejs", "deno", "bun",
  "python", "python2", "python3", "python3.10", "python3.11", "python3.12",
  "perl", "perl5", "ruby", "php", "php7", "php8",
  "lua", "tsh", "viv",
]);

const EVAL_FLAGS = new Set(["-e", "-c", "--eval", "/e", "/c", "-ec", "-ce"]);

function baseName(argv0: string): string {
  return argv0.toLowerCase();
}

/** Sanitized child environment — no inherited process.env at all. */
export function sanitizedEnv(jailRoot: string): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: jailRoot,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TERM: "dumb",
    AICE_SANDBOX: "1",
    ...(process.platform === "win32"
      ? { SystemRoot: process.env["SystemRoot"], COMSPEC: process.env["COMSPEC"] }
      : {}),
  };
}

export interface TerminalExecResult {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly outputCapped: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

/** Core spawn loop; exported for direct unit tests (bypasses policy on purpose). */
export async function execArgv(
  argv: readonly string[],
  opts: { cwd: string; timeoutMs: number; maxBytes?: number },
): Promise<TerminalExecResult> {
  const maxBytes = opts.maxBytes ?? TERMINAL_MAX_OUTPUT_BYTES;
  return new Promise<TerminalExecResult>((resolveExec) => {
    let child;
    try {
      child = spawn(argv[0] as string, argv.slice(1), {
        cwd: opts.cwd,
        env: sanitizedEnv(opts.cwd),
        stdio: ["ignore", "pipe", "pipe"],
        // detached => our own process group on posix; kill(-pid) wipes the whole tree.
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (err) {
      resolveExec({
        exitCode: null,
        signal: null,
        timedOut: false,
        outputCapped: false,
        stdout: "",
        stderr: `spawn failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let capped = false;
    let timedOut = false;
    let settled = false;

    const killTree = (): void => {
      if (child.kill("SIGTERM")) void 0;
      // Best effort: after grace, SIGKILL the group.
      const killer = setTimeout(() => {
        try {
          killGroup(child.pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }, 250);
      killer.unref?.();
    };
    const killGroup = (pid: number | undefined, sig: NodeJS.Signals): void => {
      if (pid === undefined) return;
      try {
        if (process.platform !== "win32") process.kill(-pid, sig);
        else child.kill(sig);
      } catch {
        /* ESRCH: group already reaped */
      }
    };

    const appendChunk = (which: "out" | "err", chunk: Buffer): void => {
      if (capped) return; // pipes still drain; we just stop recording
      const head = which === "out" ? stdout : stderr;
      const room = maxBytes - head.length;
      if (chunk.length <= room) {
        if (which === "out") stdout = Buffer.concat([head, chunk]);
        else stderr = Buffer.concat([head, chunk]);
      } else {
        if (room > 0) {
          if (which === "out") stdout = Buffer.concat([head, chunk.subarray(0, room)]);
          else stderr = Buffer.concat([head, chunk.subarray(0, room)]);
        }
        capped = true;
        killTree(); // flood protection: output cap reached → process dies
      }
    };

    child.stdout?.on("data", (c: Buffer) => appendChunk("out", c));
    child.stderr?.on("data", (c: Buffer) => appendChunk("err", c));

    const timeout = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid, "SIGTERM");
      const killer = setTimeout(() => killGroup(child.pid, "SIGKILL"), 250);
      killer.unref?.();
    }, opts.timeoutMs);
    timeout.unref?.();

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveExec({
        exitCode: null,
        signal: null,
        timedOut: false,
        outputCapped: capped,
        stdout: stdout.toString("utf8"),
        stderr: (stderr.toString("utf8") + `\nspawn error: ${err.message}`).trim(),
      });
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveExec({
        exitCode: code,
        signal: signal as string | null,
        timedOut,
        outputCapped: capped,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
      });
    });
  });
}

export interface ArgvRejection {
  readonly reason: string;
}

/** Pure argv-shape gate (before the classifier even runs). Exported for tests. */
export class TerminalPolicy {
  static checkShape(argv: readonly string[]): ArgvRejection | null {
    const argv0 = String(argv[0] ?? "");
    if (argv0 === "") return { reason: "empty executable" };
    if (argv0.includes("/") || argv0.includes("\\")) {
      return { reason: `executable must be a bare name from PATH (got path: ${argv0})` };
    }
    if (argv0.includes("..")) return { reason: "executable contains .. segment" };
    if (SHELL_NAMES.has(baseName(argv0))) {
      return { reason: `direct shell invocation never allowed: ${argv0}` };
    }
    if (EVAL_INTERPRETERS.has(baseName(argv0))) {
      for (let i = 1; i < argv.length; i++) {
        const flag = String(argv[i]).toLowerCase();
        if (EVAL_FLAGS.has(flag)) {
          return { reason: `interpeter eval flag never allowed: ${argv0} ${flag}` };
        }
      }
    }
    return null;
  }
}

export const terminalExec: Tool = {
  id: "terminal.exec",
  description:
    "Execute an allowlisted command argv-only, cwd-jailed, env-sanitized, output-capped.",
  defaultRisk: "medium",
  argsSchema: {
    argv: { type: "string[]", required: true, maxItems: 64 },
    timeoutMs: { type: "number" },
    cwd: { type: "string", maxLength: 512 },
  },
  preflight(args, ctx) {
    const argv = (args["argv"] as string[]) ?? [];
    if (argv.length === 0) {
      return { fsScope: "workspace", neverAllow: true, dangerous: true };
    }
    const shape = TerminalPolicy.checkShape(argv);
    if (shape !== null) {
      return { fsScope: "workspace", neverAllow: true, dangerous: true };
    }
    if (typeof args["cwd"] === "string") {
      const probe = assertContainedSync(ctx.jailRoot, String(args["cwd"]));
      if (!probe.ok) return { fsScope: "workspace", neverAllow: true, dangerous: true };
    }
    const verdict = classifyCommand(argv);
    if (verdict.risk === "blocked") {
      return {
        fsScope: "workspace",
        neverAllow: true,
        dangerous: true,
        riskOverride: "high",
      };
    }
    return {
      fsScope: "workspace",
      dangerous: verdict.risk === "high",
      riskOverride: verdict.risk, // low|medium|high flows straight into the policy request
    };
  },
  async run(args, ctx) {
    const argv = (args["argv"] as string[]) ?? [];
    const shape = TerminalPolicy.checkShape(argv);
    if (shape !== null) throw new ToolError("EXECUTION_FAILED", shape.reason);
    const cwd = assertContainedSync(
      ctx.jailRoot,
      typeof args["cwd"] === "string" ? String(args["cwd"]) : (ctx.callCwd ?? "."),
    );
    if (!cwd.ok) throw new ToolError("JAIL_ESCAPE", cwd.error.message, [cwd.error.message]);
    const timeoutMs = Math.min(
      Math.max(Number(args["timeoutMs"] ?? TERMINAL_DEFAULT_TIMEOUT_MS), 1_000),
      TERMINAL_MAX_TIMEOUT_MS,
    );
    const res = await execArgv(argv, { cwd: cwd.path, timeoutMs });
    const relCwd = relative(ctx.jailRoot, cwd.path) || ".";
    const head = [
      `argv: ${argv.join(" ")}`,
      `cwd: ${relCwd}`,
      `exit: ${res.exitCode === null ? `null (${res.signal ?? "?"})` : res.exitCode}${res.timedOut ? ` [timeout ${timeoutMs}ms]` : ""}${res.outputCapped ? " [output capped]" : ""}`,
    ].join("\n");
    const parts = [head];
    if (res.stdout !== "") parts.push(`--- stdout ---\n${res.stdout}`);
    if (res.stderr !== "") parts.push(`--- stderr ---\n${res.stderr}`);
    return parts.join("\n");
  },
};

export const TERMINAL_TOOLS: readonly Tool[] = Object.freeze([terminalExec]);
