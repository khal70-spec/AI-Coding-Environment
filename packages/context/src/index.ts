// @ai-coding-env/context — Plan §15. Phase 0: classified-chunk model + budget helper.
// Retrieval (repo map, symbols, search) + filtering land in Phase 5.
import type { DataClassification } from "../../core/src/index.ts";

export interface ContextChunk {
  readonly id: string;
  readonly source: string; // file path, symbol, URL, or run id — never secret content
  readonly classification: DataClassification;
  /** sha256 of the raw chunk — audit log records hashes, not content. */
  readonly sha256: string;
  readonly tokens: number;
}

export interface ContextBudget {
  readonly maxTokens: number;
}

/** Greedy truncation by priority order. Pure; selection policy arrives in Phase 5. */
export function fitBudget(
  chunks: readonly ContextChunk[],
  budget: ContextBudget,
): { kept: readonly ContextChunk[]; dropped: readonly ContextChunk[] } {
  const kept: ContextChunk[] = [];
  const dropped: ContextChunk[] = [];
  let used = 0;
  for (const c of chunks) {
    if (used + c.tokens <= budget.maxTokens) {
      kept.push(c);
      used += c.tokens;
    } else {
      dropped.push(c);
    }
  }
  return { kept: Object.freeze(kept), dropped: Object.freeze(dropped) };
}
