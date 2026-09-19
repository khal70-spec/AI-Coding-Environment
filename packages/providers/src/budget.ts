// Budget enforcer — Plan §13 (P2.7). Pre-dispatch guard + post-dispatch usage ledger.
// Semantics (documented, deterministic):
//   - Pre-check: current-window spend (allowed events only) ≥ limit → BLOCKED before
//     any send. First request to cross the limit goes through, every subsequent one
//     stops (spend is only knowable after a response returns usage).
//   - USD limits are enforced only against RECORDED cost; events record $0 when the
//     model's cost rates are unknown → operator sets token limits in that case.
//   - Every block is written to budget_events (decision='blocked') and audited.
//   - hardBlock is the only mode shipped in Phase 2 (soft alerting lands with UI).
import {
  BudgetEventsDao,
  BudgetsDao,
  ModelsDao,
  naturalModelId,
  type BudgetRow,
  type BudgetWindow,
} from "../../storage/src/index.ts";
import { redact } from "../../security/src/redact.ts";
import { ProviderError } from "./errors.ts";
import type { ProviderEventSink } from "./dispatcher.ts";

export interface BudgetDeps {
  readonly budgets: BudgetsDao;
  readonly events: BudgetEventsDao;
  readonly models?: ModelsDao;
  readonly now?: () => Date;
  readonly audit?: ProviderEventSink;
}

/** Window start in UTC ISO (null = since epoch for 'total'). */
export function windowStartIso(now: Date, window: BudgetWindow): string | null {
  if (window === "total") return null;
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  if (window === "daily") return new Date(Date.UTC(y, m, d)).toISOString();
  if (window === "monthly") return new Date(Date.UTC(y, m, 1)).toISOString();
  // weekly: ISO week starts Monday
  const weekday = now.getUTCDay(); // 0=Sun
  const back = (weekday + 6) % 7;
  return new Date(Date.UTC(y, m, d - back)).toISOString();
}

export interface GuardArgs {
  readonly providerId: string;
  readonly model: string; // native model name (as sent on the wire)
  readonly taskId?: string;
}

export interface RecordArgs extends GuardArgs {
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
}

export class BudgetEnforcer {
  private readonly deps: BudgetDeps;
  constructor(deps: BudgetDeps) {
    this.deps = deps;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private emitBlocked(args: GuardArgs, budget: BudgetRow, used: string): void {
    this.deps.audit?.({
      kind: "provider.dispatch.denied",
      providerId: args.providerId,
      model: args.model,
      code: "BUDGET_EXCEEDED",
      detail: `budget ${budget.id} (${budget.scope}:${budget.scopeId}/${budget.window}) limit hit (${used})`,
    });
  }

  /** Throw BUDGET_EXCEEDED when any matching budget is over its limit. Pre-dispatch. */
  guard(args: GuardArgs): void {
    const now = this.now();
    const checks: readonly BudgetRow[] = [
      ...this.deps.budgets.list({ scope: "provider", scopeId: args.providerId }),
      ...this.deps.budgets.list({ scope: "model", scopeId: naturalModelId(args.providerId, args.model) }),
    ];
    for (const b of checks) {
      const startIso = windowStartIso(now, b.window);
      const spend = this.deps.events.sumsSince(b.scope, b.scopeId, startIso);
      const breaches: string[] = [];
      if (b.limitUsd !== null && spend.costUsd >= b.limitUsd) {
        breaches.push(`usd $${spend.costUsd.toFixed(4)}/$${b.limitUsd}`);
      }
      if (b.limitTokensIn !== null && spend.tokensIn >= b.limitTokensIn) {
        breaches.push(`tokens-in ${spend.tokensIn}/${b.limitTokensIn}`);
      }
      if (b.limitTokensOut !== null && spend.tokensOut >= b.limitTokensOut) {
        breaches.push(`tokens-out ${spend.tokensOut}/${b.limitTokensOut}`);
      }
      if (breaches.length === 0 || !b.hardBlock) continue;
      const used = breaches.join(", ");
      this.deps.events.append({
        providerId: args.providerId,
        modelId: naturalModelId(args.providerId, args.model),
        taskId: args.taskId,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        decision: "blocked",
        detail: `budget ${b.id}/${b.window} exceeded (${redact(used).text})`,
      });
      this.emitBlocked(args, b, used);
      throw new ProviderError(
        "BUDGET_EXCEEDED",
        `budget exceeded for ${b.scope} ${b.scopeId} (${b.window}): ${used}`,
      );
    }
  }

  /** Record actual usage after a successful completion (allowed event). */
  record(args: RecordArgs): void {
    const pluralModelId = naturalModelId(args.providerId, args.model);
    let costUsd = 0;
    let costKnown = false;
    if (this.deps.models !== undefined) {
      const row = this.deps.models.get(pluralModelId);
      if (row !== undefined && row.costPerMtokIn !== null && row.costPerMtokOut !== null) {
        costUsd =
          (args.usage.inputTokens / 1_000_000) * row.costPerMtokIn +
          (args.usage.outputTokens / 1_000_000) * row.costPerMtokOut;
        costKnown = true;
      }
    }
    this.deps.events.append({
      providerId: args.providerId,
      modelId: pluralModelId,
      taskId: args.taskId,
      tokensIn: args.usage.inputTokens,
      tokensOut: args.usage.outputTokens,
      costUsd,
      decision: "allowed",
      detail: costKnown ? undefined : "cost rates unknown — $0 recorded (token limits still enforce)",
    });
  }
}

/** Structural hook for the dispatcher (keeps storage out of the dispatch core). */
export interface BudgetHook {
  guard(args: GuardArgs): void;
  record(args: RecordArgs): void;
}
