// Sandbox capability detection — Plan §19 (P3.2 level 2 markers).
// Read-only: scans PATH for OS-level sandboxers (bubblewrap, firejail) and reads
// container/flatpak env markers. No execution, no I/O beyond stat/readdir.
// Downstream (P3.3+) will pick executor strength from this report; the contract is:
//   level 1 — argv-only + cwd jail + env allowlist (always available, current)
//   level 2 — bwrap/firejail available: network-namespace + bind-mount jails possible
import { readdirSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

export interface SandboxReport {
  /** Strongest sandbox level we can provision right now. */
  readonly maxLevel: 1 | 2;
  readonly bwrap: string | null;
  readonly firejail: string | null;
  /** True inside common container markers (docker/podman/systemd-nspawn). */
  readonly containerized: boolean;
  readonly flatpak: boolean;
  /** PATH entries that were search-able (diagnostics for doctor). */
  readonly scannedPathDirs: readonly string[];
}

export function findOnPath(bin: string, pathDirs: readonly string[]): string | null {
  for (const dir of pathDirs) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue; // unreadable PATH entry — skip, don't fail detection
    }
    if (!names.includes(bin)) continue;
    const candidate = join(dir, bin);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

export function detectSandbox(
  env: Readonly<Record<string, string | undefined>> = process.env as Record<string, string | undefined>,
): SandboxReport {
  const pathStr = env["PATH"] ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
  const pathDirs = Object.freeze(pathStr.split(delimiter).filter((d) => d !== "" && isAbsolute(d)));
  const bwrap = findOnPath("bwrap", pathDirs);
  const firejail = findOnPath("firejail", pathDirs);
  const containerized =
    env["container"] !== undefined ||
    env["CONTAINER"] !== undefined ||
    env["KUBERNETES_SERVICE_HOST"] !== undefined;
  const flatpak = env["FLATPAK_ID"] !== undefined;
  return Object.freeze({
    maxLevel: bwrap !== null || firejail !== null ? 2 : 1,
    bwrap,
    firejail,
    containerized,
    flatpak,
    scannedPathDirs: pathDirs,
  });
}

/** Compact single-line marker for audit/doctor rows. */
export function sandboxMarker(report: SandboxReport): string {
  const parts: string[] = [`sandbox-level-${report.maxLevel}`];
  if (report.bwrap !== null) parts.push(`bwrap:${report.bwrap}`);
  if (report.firejail !== null) parts.push(`firejail:${report.firejail}`);
  if (report.containerized) parts.push("container");
  if (report.flatpak) parts.push("flatpak");
  return parts.join(" ");
}
