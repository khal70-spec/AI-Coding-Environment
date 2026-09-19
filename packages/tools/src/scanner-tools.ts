// scan.exec — Plan §24 (P3.4): Semgrep / Gitleaks / OSV / Trivy adapters.
// Guarantees: argv-only allowlisted invocations (sanitized env, cwd jail, group
// kill on timeout), OFFLINE-ONLY flags (no egress by construction at level 1),
// findings normalized into the security_findings row shape and returned via the
// runner's data channel — persistence is the caller's job (task-scoped rows).
import { delimiter } from "node:path";
import { execArgv } from "./terminal.ts";
import { findOnPath } from "./sandbox-detect.ts";
import { assertContainedSync } from "../../security/src/paths.ts";
import { ToolError, type Tool, type ToolContext } from "./runtime.ts";


export type ScannerId = "gitleaks" | "semgrep" | "osv-scanner" | "trivy";
export const SCANNER_IDS: readonly ScannerId[] = Object.freeze(["gitleaks", "semgrep", "osv-scanner", "trivy"]);

export interface NormalizedFinding {
  readonly severity: "info" | "low" | "medium" | "high" | "critical";
  readonly ruleId: string;
  readonly location: string | null;
  readonly summary: string;
}

const FINDING_CAP = 500;
const SCAN_PARSE_BYTES = 4 * 1024 * 1024;
const SCAN_DEFAULT_TIMEOUT_MS = 180_000;

interface ScannerAdapter {
  readonly bin: string;
  argv(cwd: string): readonly string[];
  parse(stdout: string): NormalizedFinding[];
}

function clip(s: string, n = 240): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

/** The PATH the sandbox hands to children — scanners must be locatable there. */
export function scannerSearchPath(): readonly string[] {
  return "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin".split(delimiter).filter((d) => d !== "");
}

const gitleaks: ScannerAdapter = {
  bin: "gitleaks",
  argv: (cwd) => [
    "gitleaks", "detect", "--no-banner", "--redact", "--report-format", "json",
    "--report-path", "/dev/stdout", "--source", cwd,
  ],
  parse(stdout) {
    const rows = JSON.parse(stdout || "[]") as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      severity: "high" as const,
      ruleId: `gitleaks::${String(r["RuleID"] ?? "unknown")}`,
      location:
        r["File"] !== undefined ? `${String(r["File"])}:${String(r["StartLine"] ?? "?")}` : null,
      summary: clip(String(r["Description"] ?? "matched secret pattern")),
    }));
  },
};

const semgrep: ScannerAdapter = {
  bin: "semgrep",
  argv: (cwd) => ["semgrep", "scan", "--config", "auto", "--json", "--quiet", "--metrics=off", cwd],
  parse(stdout) {
    const doc = JSON.parse(stdout) as { results?: Array<Record<string, unknown>> };
    const sevMap: Record<string, NormalizedFinding["severity"]> = {
      ERROR: "high", WARNING: "medium", INFO: "info",
    };
    return (doc.results ?? []).map((r) => {
      const extra = r["extra"] as Record<string, unknown> | undefined;
      const start = r["start"] as Record<string, unknown> | undefined;
      const rawSev = String(extra?.["severity"] ?? "INFO").toUpperCase();
      return {
        severity: sevMap[rawSev] ?? "info",
        ruleId: `semgrep::${String(r["check_id"] ?? "unknown")}`,
        location:
          r["path"] !== undefined ? `${String(r["path"])}:${String(start?.["line"] ?? "?")}` : null,
        summary: clip(String(extra?.["message"] ?? "semgrep finding")),
      };
    });
  },
};

const osvScanner: ScannerAdapter = {
  bin: "osv-scanner",
  argv: (cwd) => ["osv-scanner", "scan", "--format", "json", "--offline-vulnerabilities", "-r", cwd],
  parse(stdout) {
    interface OsvVuln {
      id?: string;
      summary?: string;
      database_specific?: { severity?: string };
      packages?: Array<{ package?: { name?: string; version?: string } }>;
    }
    const doc = JSON.parse(stdout || "{}") as { results?: Array<{ packages?: OsvVuln & Array<unknown> }> };
    const out: NormalizedFinding[] = [];
    const sevMap: Record<string, NormalizedFinding["severity"]> = {
      CRITICAL: "critical", HIGH: "high", MODERATE: "medium", MEDIUM: "medium", LOW: "low",
    };
    const results = (doc.results ?? []) as Array<Record<string, unknown>>;
    for (const res of results) {
      const pkgs = (res["packages"] as Array<Record<string, unknown>> | undefined) ?? [];
      for (const pkg of pkgs) {
        const vulns = (pkg["vulnerabilities"] as Array<Record<string, unknown>> | undefined) ?? [];
        const pkgMeta = pkg["package"] as Record<string, unknown> | undefined;
        const pName = String(pkgMeta?.["name"] ?? "?");
        const pVer = String(pkgMeta?.["version"] ?? "?");
        for (const v of vulns) {
          const db = v["database_specific"] as Record<string, unknown> | undefined;
          const sev = sevMap[String(db?.["severity"] ?? "").toUpperCase()] ?? "medium";
          out.push({
            severity: sev,
            ruleId: `osv::${String(v["id"] ?? "unknown")}`,
            location: `${pName}@${pVer}`,
            summary: clip(String(v["summary"] ?? "known vulnerability")),
          });
        }
      }
    }
    return out;
  },
};

const trivy: ScannerAdapter = {
  bin: "trivy",
  argv: (cwd) => ["trivy", "fs", "--format", "json", "--quiet", "--offline-scan", "--skip-db-update", cwd],
  parse(stdout) {
    const doc = JSON.parse(stdout) as { Results?: Array<Record<string, unknown>> };
    const sevMap: Record<string, NormalizedFinding["severity"]> = {
      CRITICAL: "critical", HIGH: "high", MEDIUM: "medium", LOW: "low",
    };
    const out: NormalizedFinding[] = [];
    for (const res of doc.Results ?? []) {
      const target = String(res["Target"] ?? "");
      const vulns = (res["Vulnerabilities"] as Array<Record<string, unknown>> | undefined) ?? [];
      for (const v of vulns) {
        out.push({
          severity: sevMap[String(v["Severity"] ?? "").toUpperCase()] ?? "info",
          ruleId: `trivy::${String(v["VulnerabilityID"] ?? "unknown")}`,
          location: target !== "" ? `${target} ${String(v["PkgName"] ?? "")}`.trim() : String(v["PkgName"] ?? ""),
          summary: clip(String(v["Title"] ?? v["Description"] ?? "vulnerability")),
        });
      }
      const mis = (res["Misconfigurations"] as Array<Record<string, unknown>> | undefined) ?? [];
      for (const m of mis) {
        out.push({
          severity: sevMap[String(m["Severity"] ?? "").toUpperCase()] ?? "info",
          ruleId: `trivy::${String(m["ID"] ?? "unknown")}`,
          location: target !== "" ? target : null,
          summary: clip(String(m["Title"] ?? m["Description"] ?? "misconfiguration")),
        });
      }
    }
    return out;
  },
};

const ADAPTERS: Readonly<Record<ScannerId, ScannerAdapter>> = Object.freeze({
  gitleaks, semgrep, "osv-scanner": osvScanner, trivy,
});

export function scannerArgv(id: ScannerId, cwd: string): readonly string[] {
  return ADAPTERS[id].argv(cwd);
}

export function parseScannerOutput(id: ScannerId, stdout: string): readonly NormalizedFinding[] {
  return Object.freeze(ADAPTERS[id].parse(stdout));
}

export function countBySeverity(findings: readonly NormalizedFinding[]): Record<string, number> {
  const counts: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  return counts;
}

export const scanExec: Tool = {
  id: "scan.exec",
  description:
    "Run an allowlisted security scanner (offline) inside the jail; findings normalized + capped.",
  defaultRisk: "medium",
  argsSchema: {
    scanner: { type: "string", required: true, maxLength: 32 },
    timeoutMs: { type: "number" },
  },
  preflight(args) {
    const req = String(args["scanner"] ?? "");
    if (!SCANNER_IDS.includes(req as ScannerId)) {
      return { fsScope: "workspace", neverAllow: true, dangerous: true };
    }
    return { fsScope: "workspace", riskOverride: "medium" };
  },
  async run(args, ctx: ToolContext) {
    const id = String(args["scanner"]) as ScannerId;
    const adapter = ADAPTERS[id];
    const cwd = assertContainedSync(ctx.jailRoot, ".");
    if (!cwd.ok) throw new ToolError("JAIL_ESCAPE", cwd.error.message);
    const bin = findOnPath(adapter.bin, scannerSearchPath());
    if (bin === null) {
      throw new ToolError(
        "EXECUTION_FAILED",
        `scanner not installed on sandbox PATH: ${adapter.bin} (install it or select a different scanner)`,
      );
    }
    const timeoutMs = Math.min(Math.max(Number(args["timeoutMs"] ?? SCAN_DEFAULT_TIMEOUT_MS), 1_000), 600_000);
    const started = Date.now();
    const res = await execArgv(adapter.argv(cwd.path), {
      cwd: cwd.path,
      timeoutMs,
      maxBytes: SCAN_PARSE_BYTES,
    });
    let findings: NormalizedFinding[] = [];
    let parseNote = "";
    try {
      findings = adapter.parse(res.stdout);
    } catch (err) {
      parseNote = `parse warning: ${err instanceof Error ? err.message : String(err)}`;
    }
    const capped = findings.slice(0, FINDING_CAP);
    const counts = countBySeverity(capped);
    const durationMs = Date.now() - started;
    const summaryLine =
      `scan.exec summary: scanner=${id} findings=${capped.length}` +
      `${findings.length > capped.length ? ` (of ${findings.length}, capped)` : ""}` +
      ` [critical=${counts.critical} high=${counts.high} medium=${counts.medium} low=${counts.low} info=${counts.info}]` +
      ` exit=${res.exitCode ?? "null"}${res.timedOut ? " [timeout]" : ""} duration=${durationMs}ms`;
    const parts = [summaryLine];
    if (parseNote !== "") parts.push(parseNote);
    for (const f of capped.slice(0, 50)) {
      parts.push(`${f.severity.padEnd(8)} ${f.ruleId}${f.location ? ` @ ${f.location}` : ""} — ${f.summary}`);
    }
    if (res.exitCode !== 0 && res.stderr.trim() !== "" && capped.length === 0) {
      parts.push(`--- stderr tail ---\n${res.stderr.trim().slice(-800)}`);
    }
    return {
      text: parts.join("\n"),
      data: {
        scanner: id,
        exitCode: res.exitCode,
        timedOut: res.timedOut,
        truncated: findings.length > capped.length,
        counts,
        findings: capped,
        durationMs,
      },
    };
  },
};

export const SCANNER_TOOLS: readonly Tool[] = Object.freeze([scanExec]);
