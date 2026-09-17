#!/usr/bin/env node
// aice — operator/CI CLI. Phase 0: version/help/doctor only (offline-safe).
// Project/task commands arrive in Phase 1 on top of SQLite + git safety.

const VERSION = "0.1.0-phase0";

function help(): string {
  return [
    `aice ${VERSION} — AI Coding Environment operator CLI`,
    "",
    "Usage: aice <command>",
    "",
    "Commands:",
    "  version    Print version",
    "  help       Print this help",
    "  doctor     Offline environment self-check (node version, repo layout)",
    "",
    "Phase 1+: projects, tasks, runs, audit (all offline-capable).",
  ].join("\n");
}

async function doctor(): Promise<{ ok: boolean; lines: string[] }> {
  const lines: string[] = [];
  const major = Number(process.versions.node.split(".")[0]);
  lines.push(`node: ${process.version} ${major >= 20 ? "OK" : "FAIL (need >= 20)"}`);
  const { access } = await import("node:fs/promises");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  for (const p of ["packages/core/src/index.ts", "packages/policy/src/index.ts", "packages/storage/schema.sql"]) {
    try {
      await access(join(root, p));
      lines.push(`${p}: OK`);
    } catch {
      lines.push(`${p}: MISSING`);
    }
  }
  const ok = major >= 20 && lines.every((l) => !l.includes("MISSING") && !l.includes("FAIL"));
  return { ok, lines };
}

async function main(argv: readonly string[]): Promise<number> {
  const cmd = argv[2] ?? "help";
  if (cmd === "version") {
    console.log(VERSION);
    return 0;
  }
  if (cmd === "doctor") {
    const { ok, lines } = await doctor();
    console.log(lines.join("\n"));
    return ok ? 0 : 1;
  }
  console.log(help());
  return cmd === "help" ? 0 : 1;
}

const code = await main(process.argv);
process.exit(code);
