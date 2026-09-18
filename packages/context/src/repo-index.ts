// Repo index (P5.1, Plan §54.20): deterministic, offline inventory of a workspace.
// Design rules (mirror the P3 jail posture + Plan §26 "holds hashes, not content"):
//   - lexical walk confined to the root; SYMLINKS ARE NEVER FOLLOWED (escape-proof);
//   - binary & oversized files are skipped for content (inventory keeps metadata only);
//   - symbol/edge extraction is regex-based per language family — fast, language-light,
//     structurally incapable of executing anything (no tree-sitter, no eval);
//   - secret-prone paths (dot env, key material, certs) are EXCLUDED from content reads.
import { createHash } from "node:crypto";
import { readdirSync, lstatSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";

export const MAX_INDEXABLE_BYTES = 256 * 1024;
export const MAX_INDEX_FILES = 5000;

export type Language = "typescript" | "python" | "csharp" | "php" | "markdown" | "json" | "other";

export interface FileEntry {
  readonly path: string; // POSIX-style, root-relative
  readonly language: Language;
  readonly bytes: number;
  readonly sha256: string; // of the raw bytes
}

export interface SymbolEntry {
  readonly file: string;
  readonly name: string;
  readonly kind: "function" | "class" | "type" | "component";
  readonly line: number;
}

export interface Edge {
  readonly from: string; // file
  readonly to: string; // file (must resolve inside the repo, internal edges only)
  readonly spec: string; // raw import spec (for audit)
}

export interface RepoIndex {
  readonly root: string;
  readonly builtAt: string;
  readonly files: readonly FileEntry[];
  readonly symbols: readonly SymbolEntry[];
  readonly edges: readonly Edge[];
  readonly skipped: readonly { path: string; reason: string }[];
}

export const REPO_INDEX_FILENAME = ".aice/context/index.json";

const DIR_EXCLUDES = new Set([
  ".git", "node_modules", ".aice", "dist", "build", "out", "coverage", "target",
  "__pycache__", ".venv", "venv", ".idea", ".vscode", ".next", ".cache", ".local",
]);

/** Never read these for content (also excluded from retrieval by filter rules). */
const SECRET_PATH_PATTERNS: readonly RegExp[] = [
  /(^|\/)\.env(\..+)?$/i,
  /\.(pem|key|pfx|p12|p8)$/i,
  /(^|\/)(id_rsa|id_ed25519|known_hosts)(\.|$)/i,
  /(^|\/)secrets?\//i,
  /\.secrets\./i,
];

export function isSecretPronePath(relPosixPath: string): boolean {
  return SECRET_PATH_PATTERNS.some((r) => r.test(relPosixPath));
}

const EXT_LANGUAGE: Readonly<Record<string, Language>> = {
  ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".js": "typescript", ".jsx": "typescript", ".mjs": "typescript", ".cjs": "typescript",
  ".py": "python", ".pyi": "python",
  ".cs": "csharp",
  ".php": "php",
  ".md": "markdown", ".mdx": "markdown",
  ".json": "json",
};

function languageOf(path: string): Language {
  return EXT_LANGUAGE[extname(path).toLowerCase()] ?? "other";
}

const BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".gz", ".tar",
  ".woff", ".woff2", ".ttf", ".eot", ".exe", ".dll", ".so", ".dylib", ".class",
  ".jar", ".wasm", ".sqlite", ".db", ".lockb",
]);

interface SymbolRule {
  readonly kind: SymbolEntry["kind"];
  readonly re: RegExp;
  readonly group: number;
}

const SYMBOL_RULES: Readonly<Record<Language, readonly SymbolRule[]>> = {
  typescript: [
    { kind: "function", re: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g, group: 1 },
    { kind: "function", re: /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*[:=][^=]*(?:=>|function)/g, group: 1 },
    { kind: "class", re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g, group: 1 },
    { kind: "type", re: /^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/g, group: 1 },
  ],
  python: [
    { kind: "function", re: /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/g, group: 1 },
    { kind: "class", re: /^\s*class\s+([A-Za-z_][\w]*)\s*[(:]/g, group: 1 },
  ],
  csharp: [
    { kind: "class", re: /^\s*(?:public|internal|private|protected|static|sealed|partial|\s)+class\s+([A-Za-z_][\w]*)/g, group: 1 },
    { kind: "function", re: /^\s*(?:public|internal|private|protected|static|override|virtual|sealed|\s)+[A-Za-z_][\w<>\[\]]*\s+([A-Za-z_][\w]*)\s*\([^;]*\)\s*[{:=>]/g, group: 1 },
  ],
  php: [
    { kind: "function", re: /^\s*(?:public|protected|private|static|\s)*function\s+([A-Za-z_][\w]*)\s*\(/g, group: 1 },
    { kind: "class", re: /^\s*(?:final\s+|abstract\s+)?class\s+([A-Za-z_][\w]*)/g, group: 1 },
  ],
  markdown: [],
  json: [],
  other: [],
};

const IMPORT_SPECS: Readonly<Record<Language, readonly RegExp[]>> = {
  typescript: [
    /import\s+(?:type\s+)?(?:[^"'`]*?\s+from\s+)?["'`]([^"'`]+)["'`]/g,
    /require\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
  ],
  python: [/^\s*from\s+([\w.]+)\s+import\s/gm, /^\s*import\s+([\w.]+)\s*$/gm],
  csharp: [/^\s*using\s+([A-Za-z][\w.]*)\s*;/gm],
  php: [/require(?:_once)?\s*\(?\s*['"]([^'"]+)['"]/g, /^\s*use\s+([A-Za-z][\w\\]*)\s*;/gm],
  markdown: [],
  json: [],
  other: [],
};

const CODE_EXTS: Readonly<Record<Language, readonly string[]>> = {
  typescript: [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"],
  python: [".py"],
  csharp: [".cs"],
  php: [".php"],
  markdown: [],
  json: [],
  other: [],
};

function toPosix(p: string): string {
  return p.split("\\").join("/");
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Resolve an import spec to an in-repo file path, or null (package/builtin/out-of-root). */
function resolveImport(fromRelPosix: string, spec: string, lang: Language, files: ReadonlyMap<string, FileEntry>): string | null {
  const baseDir = fromRelPosix.split("/").slice(0, -1).join("/");
  let candidate: string | null = null;
  if (lang === "typescript" || lang === "php") {
    if (!spec.startsWith("./") && !spec.startsWith("../")) return null; // package import
    const joined = join(baseDir, spec);
    if (!fromRelPosix.startsWith(".") && joined.startsWith("..")) return null;
    candidate = toPosix(joined);
  } else if (lang === "python") {
    if (spec.startsWith(".") || !/^[A-Za-z_][\w.]*$/.test(spec)) return null;
    const joined = join(baseDir, spec.replace(/\./g, "/"));
    candidate = toPosix(joined);
  } else {
    return null; // csharp namespaces aren't file paths
  }
  const exts = CODE_EXTS[lang];
  if (files.has(candidate)) return candidate;
  for (const ext of exts) {
    if (files.has(`${candidate}${ext}`)) return `${candidate}${ext}`;
    if (files.has(`${candidate}/index${ext}`)) return `${candidate}/index${ext}`;
    if (lang === "python" && files.has(`${candidate}/__init__.py`)) return `${candidate}/__init__.py`;
  }
  return null;
}

/** Walk the root deterministically (lexicographic), never following symlinks. */
function* walk(root: string): Generator<string> {
  const stack: string[] = [""];
  let count = 0;
  while (stack.length > 0) {
    const dir = stack.shift() as string;
    const absDir = join(root, dir);
    let entries: string[] = [];
    try {
      entries = readdirSync(absDir).sort();
    } catch {
      continue;
    }
    for (const name of entries) {
      const rel = toPosix(join(dir, name));
      const abs = join(absDir, name);
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue; // policy: never followed (out-of-root escape proof)
      if (st.isDirectory()) {
        if (!DIR_EXCLUDES.has(name)) stack.push(rel);
        continue;
      }
      if (!st.isFile()) continue;
      // Hidden files: secret-prone ones surface via buildRepoIndex's recorded skip;
      // all others are excluded quietly (editor/OS noise).
      if (name.startsWith(".") && !isSecretPronePath(rel)) continue;
      count += 1;
      if (count > MAX_INDEX_FILES) return;
      yield rel;
    }
  }
}

/**
 * Extract symbols/edges from one file's text (pure string ops; the model's hostile
 * content cannot affect extraction — regexes only).
 */
export function extractFromText(
  relPosixPath: string,
  text: string,
  language: Language,
): { symbols: readonly SymbolEntry[]; imports: readonly string[] } {
  const symbols: SymbolEntry[] = [];
  const rules = SYMBOL_RULES[language];
  const lines = text.split("\n");
  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const line = lines[lineNo] as string;
    if (line.length > 1000) continue; // minified bundles: skip line, don't burn time
    for (const rule of rules) {
      const re = new RegExp(rule.re.source, rule.re.flags);
      const m = re.exec(line);
      if (m !== null) {
        const name = m[rule.group];
        if (name !== undefined) {
          symbols.push({ file: relPosixPath, name, kind: rule.kind, line: lineNo + 1 });
          break;
        }
      }
    }
  }
  const imports: string[] = [];
  for (const re0 of IMPORT_SPECS[language]) {
    const re = new RegExp(re0.source, re0.flags);
    let m;
    while ((m = re.exec(text)) !== null) {
      const spec = m[1];
      if (typeof spec === "string" && spec !== "") imports.push(spec);
    }
  }
  return Object.freeze({ symbols: Object.freeze(symbols), imports: Object.freeze(imports) });
}

/** Build the full index. Errors individualize into `skipped`; the walk itself is total. */
export function buildRepoIndex(root: string): RepoIndex {
  const files = new Map<string, FileEntry>();
  const symbols: SymbolEntry[] = [];
  const importsByFile = new Map<string, readonly string[]>();
  const skipped: { path: string; reason: string }[] = [];

  for (const rel of walk(root)) {
    if (isSecretPronePath(rel)) {
      skipped.push({ path: rel, reason: "secret-prone path (never indexed)" });
      continue;
    }
    const abs = join(root, rel);
    let buf: Buffer;
    try {
      buf = readFileSync(abs);
    } catch {
      skipped.push({ path: rel, reason: "unreadable" });
      continue;
    }
    const language = languageOf(rel);
    const entry: FileEntry = { path: rel, language, bytes: buf.length, sha256: sha256(buf) };
    files.set(rel, entry);
    const tooBig = buf.length > MAX_INDEXABLE_BYTES;
    if (tooBig) {
      skipped.push({ path: rel, reason: `oversize>${MAX_INDEXABLE_BYTES}` });
      continue;
    }
    if (BINARY_EXTS.has(extname(rel).toLowerCase()) || buf.includes(0)) continue;
    const text = buf.toString("utf8");
    const { symbols: s, imports: i } = extractFromText(rel, text, language);
    for (const sym of s) symbols.push(sym);
    importsByFile.set(rel, i);
  }

  const edges: Edge[] = [];
  for (const [from, specs] of importsByFile) {
    const entry = files.get(from);
    if (entry === undefined) continue;
    for (const spec of specs) {
      const to = resolveImport(from, spec, entry.language, files);
      if (to !== null) edges.push({ from, to, spec });
    }
  }

  return Object.freeze({
    root,
    builtAt: new Date().toISOString(),
    files: Object.freeze([...files.values()]),
    symbols: Object.freeze(symbols),
    edges: Object.freeze(edges),
    skipped: Object.freeze(skipped),
  });
}

/** Persist (jail-local; artifacts live with the workspace, never in the repo tree). */
export function persistRepoIndex(root: string, index: RepoIndex): string {
  const p = join(root, REPO_INDEX_FILENAME);
  mkdirSync(join(root, ".aice", "context"), { recursive: true });
  writeFileSync(p, JSON.stringify(index, null, 1));
  return p;
}

/** Load a persisted index (returns undefined when absent-stale). */
export function loadRepoIndex(root: string): RepoIndex | undefined {
  const p = join(root, REPO_INDEX_FILENAME);
  try {
    return JSON.parse(readFileSync(p, "utf8")) as RepoIndex;
  } catch {
    return undefined;
  }
}
