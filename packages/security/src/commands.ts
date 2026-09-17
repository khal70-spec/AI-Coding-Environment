// Command classification — Plan §9, §18. Tools take argv[], never raw shell.
// The classifier maps argv to risk + policy decision hints. Policy engine makes the
// final call; this module only reports what it sees.

export type CommandRisk = "low" | "medium" | "high" | "blocked";

export interface CommandVerdict {
  readonly risk: CommandRisk;
  readonly reasons: readonly string[];
  /** True when the argv must never execute regardless of approvals (e.g. secret exfil shapes). */
  readonly neverExecute: boolean;
}

/** Shell metacharacters that indicate a raw-shell string instead of argv. */
const SHELL_META = /[;&|`$(){}<>!#~*?[\]\\"']/;

export function looksLikeRawShell(input: string): boolean {
  return SHELL_META.test(input);
}

function joinArgs(argv: readonly string[]): string {
  return argv.join(" ");
}

export function classifyCommand(argv: readonly string[]): CommandVerdict {
  const reasons: string[] = [];
  if (argv.length === 0) {
    return { risk: "blocked", reasons: ["empty command"], neverExecute: true };
  }
  const [cmd, ...rest] = argv as [string, ...string[]];
  const base = cmd.split("/").pop() ?? cmd;
  const joined = joinArgs(argv).toLowerCase();

  // --- Always-block shapes ---
  // Secret exfil shapes can never be approved through normal flow. (Checked first:
  // piped-exfil also matches the generic curl|sh rule below, which is weaker.)
  if (/env\s*\|\s*(curl|wget|nc|netcat)/.test(joined) || /(curl|wget).*(passwd|shadow|\.pem|\.key\b)/.test(joined)) {
    reasons.push("probable credential/file exfiltration");
    return { risk: "blocked", reasons, neverExecute: true };
  }
  if (joined.includes("curl") && joined.includes("|") && joined.includes("sh")) {
    reasons.push("piped remote code execution (curl|sh)");
    return { risk: "blocked", reasons, neverExecute: false };
  }
  if (/\b(dd|mkfs|fdisk|parted)\b/.test(joined)) {
    reasons.push("raw disk / partition operation");
    return { risk: "blocked", reasons, neverExecute: false };
  }
  if (/\b(shutdown|reboot|halt|poweroff|init\s+[06])\b/.test(joined)) {
    reasons.push("host power control");
    return { risk: "blocked", reasons, neverExecute: false };
  }
  if (/\bdrop\s+database\b/.test(joined) || /\bdrop\s+table\b/.test(joined)) {
    reasons.push("destructive SQL (DROP DATABASE/TABLE)");
    return { risk: "blocked", reasons, neverExecute: false };
  }
  if (base === "rm" || joined.startsWith("sudo rm")) {
    const targets = rest.filter((a) => !a.startsWith("-"));
    const flags = rest.filter((a) => a.startsWith("-")).join("");
    const recursive = flags.includes("r") || flags.includes("R");
    const dangerousTarget = targets.some((t) =>
      ["", "/", "/*", "~", "~/*", ".", "./", "*", "./*"].includes(t.trim()) ||
      t.trim() === "$HOME" ||
      /^\/[^/]*$/.test(t.trim()),
    );
    if (recursive && (dangerousTarget || targets.length === 0)) {
      reasons.push("destructive recursive deletion");
      return { risk: "blocked", reasons, neverExecute: false };
    }
    if (recursive) {
      reasons.push("recursive deletion requires approval");
      return { risk: "high", reasons, neverExecute: false };
    }
    reasons.push("file deletion");
    return { risk: "medium", reasons, neverExecute: false };
  }
  if (base === "git" && /(push.*--force|push.*-f\b|push.*--delete)/.test(joined)) {
    reasons.push("force-push or remote branch deletion");
    return { risk: "blocked", reasons, neverExecute: false };
  }
  if (base === "git" && /reset\s+--hard/.test(joined)) {
    reasons.push("git reset --hard destroys uncommitted work");
    return { risk: "blocked", reasons, neverExecute: false };
  }
  if (base === "git" && /clean\s+-[a-z]*f[a-z]*d/.test(joined)) {
    reasons.push("git clean -fd destroys untracked work");
    return { risk: "blocked", reasons, neverExecute: false };
  }
  if (/\bchmod\s+-r\s+777\b/.test(joined)) {
    reasons.push("world-writable recursive chmod");
    return { risk: "blocked", reasons, neverExecute: false };
  }
  if (/\b(iptables|ufw|firewall-cmd|setenforce)\b/.test(joined)) {
    reasons.push("firewall / MAC policy change");
    return { risk: "blocked", reasons, neverExecute: false };
  }
  if (/\b(systemctl|service)\s+(stop|disable)\b/.test(joined)) {
    reasons.push("service stop/disable");
    return { risk: "blocked", reasons, neverExecute: false };
  }
  // --- Elevated but approvable ---
  if (/^(sudo|su|doas)\b/.test(joined)) {
    reasons.push("privilege escalation prefix");
    return { risk: "high", reasons, neverExecute: false };
  }
  if (/\b(npm|pip|composer|cargo|dotnet)\s+(install|add|update)\b/.test(joined)) {
    reasons.push("dependency install/update (supply-chain surface)");
    return { risk: "medium", reasons, neverExecute: false };
  }
  if (/\b(kubectl|docker|terraform|aws|az|gcloud)\b/.test(joined)) {
    reasons.push("infrastructure/cloud CLI");
    return { risk: "high", reasons, neverExecute: false };
  }

  // --- Read-only low risk ---
  if (/^(git\s+(status|diff|log|show|branch|stash\s+list)|ls|cat|head|tail|wc|grep|rg|find|file|stat)\b/.test(joined)) {
    return { risk: "low", reasons: ["read-only inspection"], neverExecute: false };
  }
  return { risk: "medium", reasons: ["unclassified command — default medium"], neverExecute: false };
}
