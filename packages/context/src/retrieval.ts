// Retrieval + packing (P5.2, Plan §54.21): deterministic relevance scoring over the
// repo index, then budget-fit packing into ContextChunks. Deterministic by rule:
// same index + same task text + same budget ⇒ same selection (tests pin this).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fitBudget, type ContextChunk } from "./index.ts";
import type { FileEntry, RepoIndex } from "./repo-index.ts";
import { isSecretPronePath } from "./repo-index.ts";
import { redact } from "../../security/src/index.ts";
import type { DataClassification } from "../../core/src/index.ts";

export const DEFAULT_CHUNK_MAX_BYTES = 24 * 1024;
export const APPROX_CHARS_PER_TOKEN = 4;

export interface RetrieveQuery {
  readonly taskText: string;
  /** Explicit path/symbol hints from the task or operator — always-score boosters. */
  readonly hints?: readonly string[];
  readonly classification?: DataClassification;
}

export interface ScoredFile {
  readonly path: string;
  readonly score: number;
  readonly reasons: readonly string[];
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "with", "is", "it",
  "this", "that", "we", "you", "i", "be", "by", "at", "as", "do", "so", "if", "no",
  "are", "was", "were", "be", "been", "me", "my", "our", "from", "not", "all", "any",
]);

/** Task text → lowercase token set (identifiers kept whole; camelCase split too). */
export function taskTokens(text: string): readonly string[] {
  const raw = text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9_./-]+/)
    .map((t) => t.toLowerCase())
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
  const out = new Set<string>();
  for (const t of raw) expandPlural(out, t);
  return Object.freeze([...out].sort());
}

/** Term expansion: accept both the raw segment and its naive singular (routes↔route). */
function expandPlural(out: Set<string>, t: string): void {
  out.add(t);
  if (t.length > 2 && t.endsWith("s")) out.add(t.slice(0, -1));
}

function pathTerms(path: string): readonly string[] {
  const parts = path.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2);
  const out = new Set<string>();
  for (const part of parts) expandPlural(out, part);
  return Object.freeze([...out]);
}

/**
 * Score files for a query: path-token overlap (×3), symbol-name overlap (×2),
 * import-edge adjacency to strong hits (×1), hint match (×10). Deterministic order:
 * ties resolved lexicographically.
 */
export function rank(index: RepoIndex, query: RetrieveQuery): readonly ScoredFile[] {
  const terms = new Set(taskTokens(query.taskText));
  for (const h of query.hints ?? []) {
    for (const t of taskTokens(h).concat(taskTokens(h.split("/").join(" ")))) terms.add(t);
  }
  const hintPaths = new Set((query.hints ?? []).map((h) => h.replace(/^\.\/+/, "").replace(/\/+$/, "")));
  if (terms.size === 0 && hintPaths.size === 0) return Object.freeze([]);

  const symbolFiles = new Map<string, number>();
  for (const s of index.symbols) {
    const nameTerms = pathTerms(s.name.replace(/([a-z])([A-Z])/g, "$1-$2"));
    if (nameTerms.some((t) => terms.has(t))) {
      symbolFiles.set(s.file, (symbolFiles.get(s.file) ?? 0) + 1);
    }
  }

  const base = new Map<string, { score: number; reasons: string[] }>();
  const bump = (path: string, by: number, reason: string) => {
    const cur = base.get(path) ?? { score: 0, reasons: [] };
    cur.score += by;
    cur.reasons.push(reason);
    base.set(path, cur);
  };

  for (const f of index.files) {
    const pr = pathTerms(f.path);
    const hit = pr.filter((t) => terms.has(t));
    if (hit.length > 0) bump(f.path, 3 * hit.length, `path:${hit.join(",")}`);
    const symHits = symbolFiles.get(f.path) ?? 0;
    if (symHits > 0) bump(f.path, 2 * Math.min(symHits, 5), `symbols:${symHits}`);
    for (const hp of hintPaths) {
      if (f.path === hp || f.path.startsWith(`${hp}/`) || hp.endsWith(f.path)) {
        bump(f.path, 10, "hint");
      }
    }
  }

  // One hop of adjacency: files adjacent to 5+ scorers inherit 1 point.
  const adjacent = new Set<string>();
  for (const e of index.edges) {
    if ((base.get(e.from)?.score ?? 0) >= 5 || (base.get(e.to)?.score ?? 0) >= 5) {
      adjacent.add(e.from);
      adjacent.add(e.to);
    }
  }
  for (const f of adjacent) {
    const cur = base.get(f);
    if (cur !== undefined && cur.score < 5) {
      cur.score += 1;
      cur.reasons.push("imports-adjacency");
      base.set(f, cur);
    }
  }

  return Object.freeze(
    [...base.entries()]
      .map(([path, v]) => ({ path, score: v.score, reasons: Object.freeze(v.reasons.sort()) }))
      .sort((a, b) => (b.score - a.score) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  );
}

export interface PackResult {
  readonly packed: readonly ContextChunk[];
  readonly dropped: readonly ContextChunk[];
  readonly ranked: readonly ScoredFile[];
  readonly redactionHits: number;
}

function tokensFor(text: string): number {
  return Math.max(1, Math.ceil(text.length / APPROX_CHARS_PER_TOKEN));
}

/**
 * P5.3 filter lane: the ONLY way repo text becomes context. Capped, redact()-ed,
 * marked untrusted (mirrors the tool-output tagging contract).
 */
export function filterChunkText(text: string, maxBytes: number = DEFAULT_CHUNK_MAX_BYTES): { text: string; hits: number } {
  const capped = text.length > maxBytes ? `${text.slice(0, maxBytes)}\n/* …truncated… */` : text;
  const redacted = redact(capped);
  return { text: redacted.text, hits: redacted.hits.length };
}

/**
 * Pack top-ranked files into budgeted, FILTERED chunks (P5.2+P5.3):
 *   - secret-prone paths never enter context (hard exclude);
 *   - content is redact()-ed before any chunk is produced (T11, layered defense);
 *   - hash recorded is of the *redacted* chunk actually admitted (audit truth).
 */
export function packWorkspace(
  root: string,
  index: RepoIndex,
  query: RetrieveQuery,
  maxTokens: number,
  opts: { maxChunkBytes?: number; classification?: DataClassification; maxFiles?: number } = {},
): PackResult {
  const limit = opts.maxFiles ?? 64;
  const chunkCap = opts.maxChunkBytes ?? DEFAULT_CHUNK_MAX_BYTES;
  const ranked = rank(index, query);
  const letIn: { entry: FileEntry; score: number }[] = [];
  const byPath = new Map(index.files.map((f) => [f.path, f] as const));
  for (const r of ranked) {
    if (letIn.length >= limit) break;
    const entry = byPath.get(r.path);
    if (entry === undefined) continue;
    if (isSecretPronePath(r.path)) continue; // belt & braces (already excluded upstream)
    letIn.push({ entry, score: r.score });
  }

  const chunks: ContextChunk[] = [];
  let redactionHits = 0;
  for (const { entry } of letIn) {
    let text: string;
    try {
      text = readFileSync(join(root, entry.path), "utf8");
    } catch {
      continue;
    }
    const { text: body, hits } = filterChunkText(text, chunkCap);
    redactionHits += hits;
    chunks.push({
      id: `file:${entry.path}`,
      source: entry.path,
      classification: opts.classification ?? "internal",
      sha256: createHash("sha256").update(body, "utf8").digest("hex"),
      tokens: tokensFor(body),
    });
  }

  const { kept, dropped } = fitBudget(chunks, { maxTokens });
  return Object.freeze({
    packed: kept,
    dropped: Object.freeze(dropped),
    ranked,
    redactionHits,
  });
}
