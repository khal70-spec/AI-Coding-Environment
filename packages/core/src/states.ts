// Task state machine — Plan §32, ADR-007.
// The ONLY legal transitions. No hidden jumps. Orchestrator guards (approvals,
// checkpoints, green verify) wrap this table in @ai-coding-env/orchestrator.

export type TaskState =
  | "CREATED"
  | "CLASSIFYING"
  | "INVESTIGATING"
  | "PLANNING"
  | "WAITING_APPROVAL"
  | "PREPARING_WORKSPACE"
  | "IMPLEMENTING"
  | "TESTING"
  | "SECURITY_REVIEW"
  | "AI_REVIEW"
  | "FIXING"
  | "VERIFYING"
  | "READY"
  | "APPROVED"
  | "MERGED"
  | "BLOCKED"
  | "CANCELLED"
  | "FAILED"
  | "ROLLBACK_REQUIRED";

export type TerminalState = "MERGED" | "CANCELLED" | "FAILED";
export type FailureState = "BLOCKED" | "CANCELLED" | "FAILED" | "ROLLBACK_REQUIRED";

export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set([
  "MERGED",
  "CANCELLED",
  "FAILED",
]);

const FAILURE_EXITS: readonly TaskState[] = ["BLOCKED", "CANCELLED", "FAILED"];

/** Happy-path chain. FIXING loops back to IMPLEMENTING (bounded by orchestrator retries). */
const HAPPY_PATH: readonly (readonly [TaskState, TaskState])[] = [
  ["CREATED", "CLASSIFYING"],
  ["CLASSIFYING", "INVESTIGATING"],
  ["INVESTIGATING", "PLANNING"],
  ["PLANNING", "WAITING_APPROVAL"],
  ["WAITING_APPROVAL", "PREPARING_WORKSPACE"],
  ["PREPARING_WORKSPACE", "IMPLEMENTING"],
  ["IMPLEMENTING", "TESTING"],
  ["TESTING", "SECURITY_REVIEW"],
  ["TESTING", "FIXING"],
  ["SECURITY_REVIEW", "AI_REVIEW"],
  ["SECURITY_REVIEW", "FIXING"],
  ["AI_REVIEW", "VERIFYING"],
  ["AI_REVIEW", "FIXING"],
  ["FIXING", "IMPLEMENTING"],
  ["VERIFYING", "READY"],
  ["VERIFYING", "FIXING"],
  ["READY", "APPROVED"],
  ["APPROVED", "MERGED"],
];

function buildTransitions(): Readonly<Record<TaskState, readonly TaskState[]>> {
  const map = new Map<TaskState, Set<TaskState>>();
  const add = (from: TaskState, to: TaskState): void => {
    let set = map.get(from);
    if (set === undefined) {
      set = new Set();
      map.set(from, set);
    }
    set.add(to);
  };
  for (const [from, to] of HAPPY_PATH) add(from, to);
  // Any non-terminal state can exit to failure states.
  const all: TaskState[] = [
    "CREATED", "CLASSIFYING", "INVESTIGATING", "PLANNING", "WAITING_APPROVAL",
    "PREPARING_WORKSPACE", "IMPLEMENTING", "TESTING", "SECURITY_REVIEW",
    "AI_REVIEW", "FIXING", "VERIFYING", "READY", "APPROVED", "BLOCKED",
    "ROLLBACK_REQUIRED",
  ];
  for (const from of all) for (const to of FAILURE_EXITS) add(from, to);
  // Applied-changes failure must roll back before resting at FAILED.
  add("FAILED", "ROLLBACK_REQUIRED");
  add("ROLLBACK_REQUIRED", "FAILED");
  // Blocked tasks can resume investigation/planning after the blocker clears.
  add("BLOCKED", "INVESTIGATING");
  add("BLOCKED", "PLANNING");
  const out = {} as Record<TaskState, readonly TaskState[]>;
  const states: TaskState[] = [...all, "MERGED", "CANCELLED", "FAILED"];
  for (const s of states) out[s] = Object.freeze([...(map.get(s) ?? [])]);
  return Object.freeze(out);
}

export const TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> =
  buildTransitions();

export function canTransition(from: TaskState, to: TaskState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(state: TaskState): boolean {
  return TERMINAL_STATES.has(state);
}
