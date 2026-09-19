// Filesystem tools — Plan §18/§19 (P3.1). All paths resolve through the Phase 1
// containment kernel: lexical + symlink-safe (deepest-existing-ancestor realpath).
// fs.write/fs.edit are policy-dangerous on overwrite, never allowed outside the jail.
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { assertContainedSync } from "../../security/src/paths.ts";
import { containsSecret } from "../../security/src/redact.ts";
import { ToolError, TOOL_MAX_OUTPUT_BYTES, type Tool, type ToolContext } from "./runtime.ts";

const HARD_READ_LIMIT = 4 * 1024 * 1024; // files larger than this are always partial reads
const WRITE_CONTENT_LIMIT = 1024 * 1024; // 1 MiB per write call

/** Resolve+contain an arg path inside the jail; throws ToolError on escape. */
export function jailPath(ctx: ToolContext, rawPath: string): string {
  const res = assertContainedSync(ctx.jailRoot, rawPath);
  if (!res.ok) {
    throw new ToolError("JAIL_ESCAPE", res.error.message, [res.error.message]);
  }
  return res.path;
}

function isBinaryBuf(buf: Buffer): boolean {
  const probe = buf.subarray(0, Math.min(buf.length, 4096));
  return probe.includes(0);
}

function readPartial(path: string, cap: number): { text: string; trunc: boolean } {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(cap);
    const got = readSync(fd, buf, 0, cap, 0);
    const slice = buf.subarray(0, got);
    if (isBinaryBuf(slice)) throw new ToolError("EXECUTION_FAILED", "binary file detected (NUL bytes in first chunk)");
    return { text: slice.toString("utf8") + `\n[partial read: first ${got} bytes]`, trunc: true };
  } finally {
    closeSync(fd);
  }
}

function readFileSmart(path: string, maxBytes?: number): { text: string; trunc: boolean } {
  const st = statSync(path);
  const cap = Math.min(maxBytes ?? TOOL_MAX_OUTPUT_BYTES, HARD_READ_LIMIT);
  if (st.size <= cap) {
    const buf = readFileSync(path);
    if (isBinaryBuf(buf)) throw new ToolError("EXECUTION_FAILED", "binary file detected (NUL bytes)");
    return { text: buf.toString("utf8"), trunc: false };
  }
  return readPartial(path, cap);
}

/* ---------------------------------- fs.read ---------------------------------- */

export const fsRead: Tool = {
  id: "fs.read",
  description: "Read a file inside the workspace (capped; binary refused).",
  defaultRisk: "low",
  argsSchema: {
    path: { type: "string", required: true, maxLength: 512 },
    maxBytes: { type: "number" },
  },
  preflight: () => ({ fsReadScope: "workspace" }),
  run(args, ctx) {
    const target = jailPath(ctx, String(args["path"]));
    if (!existsSync(target)) throw new ToolError("EXECUTION_FAILED", `no such file: ${String(args["path"])}`);
    const st = statSync(target);
    if (st.isDirectory()) throw new ToolError("VALIDATION_ERROR", "path is a directory — use fs.list");
    if (!st.isFile()) throw new ToolError("VALIDATION_ERROR", "path is not a regular file");
    return readFileSmart(target, typeof args["maxBytes"] === "number" ? (args["maxBytes"] as number) : undefined).text;
  },
};

/* ---------------------------------- fs.list ---------------------------------- */

interface WalkEntry {
  readonly rel: string;
  readonly kind: "file" | "dir" | "symlink-outside";
  readonly bytes: number;
}

function walkJail(
  ctx: ToolContext,
  rootAbs: string,
  opts: { depth: number; maxEntries: number; includeHidden: boolean },
): WalkEntry[] {
  const out: WalkEntry[] = [];
  const visit = (dirAbs: string, depth: number): void => {
    if (out.length >= opts.maxEntries) return;
    let names: string[];
    try {
      names = readdirSync(dirAbs);
    } catch {
      return; // unreadable dir: skipped, not fatal
    }
    for (const name of names.sort()) {
      if (out.length >= opts.maxEntries) return;
      if (!opts.includeHidden && name.startsWith(".")) continue;
      if (name === "node_modules" || name === "__pycache__") continue;
      const abs = join(dirAbs, name);
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        // symlinked children resolve through the same kernel as writes
        const contained = assertContainedSync(ctx.jailRoot, abs);
        out.push({ rel: relative(ctx.jailRoot, abs) || name, kind: contained.ok ? "file" : "symlink-outside", bytes: 0 });
        if (!contained.ok) continue;
        st = statSync(abs);
      } else {
        out.push({ rel: relative(ctx.jailRoot, abs) || name, kind: st.isDirectory() ? "dir" : "file", bytes: st.isDirectory() ? 0 : st.size });
      }
      if (st.isDirectory() && depth < opts.depth) visit(abs, depth + 1);
    }
  };
  visit(rootAbs, 1);
  return out;
}

export const fsList: Tool = {
  id: "fs.list",
  description: "List files in the workspace (bounded, symlink-aware).",
  defaultRisk: "low",
  argsSchema: {
    path: { type: "string", maxLength: 512 },
    depth: { type: "number" },
    maxEntries: { type: "number" },
    includeHidden: { type: "boolean" },
  },
  preflight: () => ({ fsReadScope: "workspace" }),
  run(args, ctx) {
    const dir = jailPath(ctx, String(args["path"] ?? "."));
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      throw new ToolError("VALIDATION_ERROR", "path is not a directory");
    }
    const depth = Math.min(Math.max(Number(args["depth"] ?? 1), 1), 2);
    const maxEntries = Math.min(Math.max(Number(args["maxEntries"] ?? 100), 1), 500);
    const entries = walkJail(ctx, dir, {
      depth,
      maxEntries,
      includeHidden: args["includeHidden"] === true,
    });
    const lines = entries.map((e) => `${e.kind === "dir" ? "d" : e.kind === "symlink-outside" ? "S" : "f"}\t${e.rel}`);
    return `entries: ${entries.length}${entries.length >= maxEntries ? " (capped)" : ""}\n${lines.join("\n")}`;
  },
};

/* ---------------------------------- fs.write --------------------------------- */

export const fsWrite: Tool = {
  id: "fs.write",
  description: "Write a file inside the workspace (dangerous on overwrite).",
  defaultRisk: "medium",
  argsSchema: {
    path: { type: "string", required: true, maxLength: 512 },
    content: { type: "string", required: true, maxLength: WRITE_CONTENT_LIMIT },
    append: { type: "boolean" },
    createParents: { type: "boolean" },
  },
  preflight(args, ctx) {
    const raw = String(args["path"]);
    const res = assertContainedSync(ctx.jailRoot, raw);
    const escapes = !res.ok;
    const exists = res.ok && existsSync(res.path);
    const appending = args["append"] === true;
    const content = String(args["content"] ?? "");
    return {
      fsScope: "workspace",
      neverAllow: escapes, // belt-and-suspenders: neverAllow is hard-deny even for humans
      dangerous: escapes || (exists && !appending) || containsSecret(content),
    };
  },
  run(args, ctx) {
    const target = jailPath(ctx, String(args["path"]));
    const content = String(args["content"]);
    if (args["createParents"] === true) {
      // parent dir chain is containment-proven by jailPath's deepest-existing-ancestor walk
      mkdirSync(dirname(target), { recursive: true });
    }
    const parent = dirname(target);
    if (!existsSync(parent) || !statSync(parent).isDirectory()) {
      throw new ToolError("EXECUTION_FAILED", "parent directory missing (pass createParents)");
    }
    if (args["append"] === true) appendFileSync(target, content, "utf8");
    else writeFileSync(target, content, "utf8");
    const rel = relative(ctx.jailRoot, target);
    return `${args["append"] === true ? "appended" : "wrote"} ${Buffer.byteLength(content, "utf8")} bytes to ${rel}`;
  },
};

/* ---------------------------------- fs.edit ---------------------------------- */

export const fsEdit: Tool = {
  id: "fs.edit",
  description:
    "Safe-edit: literal string replace inside a workspace file. No regex; ambiguous matches refuse.",
  defaultRisk: "medium",
  argsSchema: {
    path: { type: "string", required: true, maxLength: 512 },
    search: { type: "string", required: true, maxLength: WRITE_CONTENT_LIMIT },
    replace: { type: "string", required: true, maxLength: WRITE_CONTENT_LIMIT },
    occurrence: { type: "string", maxLength: 16 },
    requireUniqueMatch: { type: "boolean" },
  },
  preflight: () => ({ fsScope: "workspace", dangerous: true }),
  run(args, ctx) {
    const target = jailPath(ctx, String(args["path"]));
    if (!existsSync(target) || !statSync(target).isFile()) {
      throw new ToolError("EXECUTION_FAILED", "target is not an existing file");
    }
    const search = String(args["search"]);
    const replace = String(args["replace"]);
    if (search === "") throw new ToolError("VALIDATION_ERROR", "search must not be empty");
    const { text, trunc } = readFileSmart(target, HARD_READ_LIMIT);
    if (trunc) throw new ToolError("EXECUTION_FAILED", `file exceeds ${HARD_READ_LIMIT} bytes — refuse blind edit`);
    const parts = text.split(search);
    const count = parts.length - 1;
    if (count === 0) throw new ToolError("EXECUTION_FAILED", "search string not found");
    const occurrence = String(args["occurrence"] ?? "first");
    if (occurrence !== "first" && occurrence !== "all") {
      throw new ToolError("VALIDATION_ERROR", "occurrence must be first|all");
    }
    if (occurrence === "first" && (args["requireUniqueMatch"] ?? true) && count > 1) {
      throw new ToolError(
        "EXECUTION_FAILED",
        `ambiguous edit: ${count} matches (pass requireUniqueMatch=false or occurrence="all")`,
      );
    }
    const replaced = parts.join(replace);
    writeFileSync(target, replaced, "utf8");
    const rel = relative(ctx.jailRoot, target);
    return `edited ${rel}: replaced ${occurrence === "all" ? count : 1}/${count} occurrence(s)`;
  },
};

/* ---------------------------------- fs.search -------------------------------- */

const SEARCH_SKIP_DIRS = new Set(["node_modules", ".git", ".aice", "__pycache__", "dist", "build", "coverage"]);

function boundedWalkFiles(
  ctx: ToolContext,
  rootAbs: string,
  cb: (abs: string) => void,
  budget: { visited: number },
): void {
  const stack: string[] = [rootAbs];
  while (stack.length > 0 && budget.visited < 10_000) {
    const dir = stack.pop() as string;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (budget.visited >= 10_000) return;
      const abs = join(dir, name);
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        const contained = assertContainedSync(ctx.jailRoot, abs);
        if (!contained.ok) continue; // out-of-jail symlink — never followed
        st = statSync(abs);
      }
      if (st.isDirectory()) {
        if (!SEARCH_SKIP_DIRS.has(name) && !name.startsWith(".")) stack.push(abs);
      } else if (st.isFile() && st.size <= HARD_READ_LIMIT) {
        budget.visited += 1;
        cb(abs);
      }
    }
  }
}

export const fsSearch: Tool = {
  id: "fs.search",
  description: "Regex search inside the workspace (read-only, bounded, capped).",
  defaultRisk: "low",
  argsSchema: {
    pattern: { type: "string", required: true, maxLength: 256 },
    path: { type: "string", maxLength: 512 },
    maxResults: { type: "number" },
    flags: { type: "string", maxLength: 8 },
  },
  preflight: () => ({ fsReadScope: "workspace" }),
  run(args, ctx) {
    const flagsRaw = String(args["flags"] ?? "");
    if (!/^[imsuy]*$/.test(flagsRaw)) throw new ToolError("VALIDATION_ERROR", "flags must be in [imsuy]");
    let re: RegExp;
    try {
      re = new RegExp(String(args["pattern"]), flagsRaw === "" ? undefined : flagsRaw);
    } catch (err) {
      throw new ToolError("VALIDATION_ERROR", `invalid regex: ${err instanceof Error ? err.message : String(err)}`);
    }
    const rootAbs = jailPath(ctx, String(args["path"] ?? "."));
    if (!existsSync(rootAbs)) throw new ToolError("EXECUTION_FAILED", "search root does not exist");
    const maxResults = Math.min(Math.max(Number(args["maxResults"] ?? 50), 1), 200);
    const lines: string[] = [];
    const budget = { visited: 0 };
    const scan = (abs: string): void => {
      if (lines.length >= maxResults) return;
      const content = readFileSync(abs);
      if (isBinaryBuf(content)) return;
      for (const [i, line] of content.toString("utf8").split("\n").entries()) {
        if (lines.length >= maxResults) return;
        re.lastIndex = 0; // fresh per line (global regex state safety)
        if (re.test(line)) lines.push(`${relative(ctx.jailRoot, abs)}:${i + 1}: ${line.slice(0, 240)}`);
      }
    };
    const st = statSync(rootAbs);
    if (st.isFile()) scan(rootAbs);
    else boundedWalkFiles(ctx, rootAbs, scan, budget);
    return `matches: ${lines.length}${lines.length >= maxResults ? " (capped)" : ""} (scanned ${budget.visited} files)\n${lines.join("\n")}`;
  },
};

export const FS_TOOLS: readonly Tool[] = Object.freeze([fsRead, fsList, fsWrite, fsEdit, fsSearch]);
