// Provider error taxonomy — Plan §13. Codes are stable across adapters so the
// failover router (P2.6) + CLI can reason about transient vs terminal failures
// without string matching. Messages are REDACTED BY CONSTRUCTION: any provider
// body snippet passes packages/security redact() before it can reach .message.

export type ProviderErrorCode =
  | "AUTH" // 401/403 or missing/unreadable credential (terminal until key fixed)
  | "RATE_LIMIT" // 429 / quota (transient; another provider may accept)
  | "CONTEXT_LENGTH" // 413 / 400 token-window errors (terminal for this request)
  | "SERVER" // 5xx / provider-side breakage (transient)
  | "NETWORK" // connect/DNS/TLS/timeout (transient)
  | "VALIDATION" // bad request shape or unusable response (terminal)
  | "SECRET_IN_REQUEST" // outbound gate rejected the messages (T11, fail closed)
  | "EGRESS_DENIED" // endpoint not allowed by provider egress policy (T10)
  | "PROTOCOL_UNSUPPORTED" // config asked for a protocol we don't implement
  | "CLASSIFICATION_DENIED"; // context data exceeds provider clearance (Plan §36)

export const TRANSIENT_CODES: ReadonlySet<ProviderErrorCode> = new Set([
  "RATE_LIMIT",
  "SERVER",
  "NETWORK",
]);

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly providerId?: string;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    code: ProviderErrorCode,
    message: string,
    opts: {
      readonly providerId?: string;
      readonly status?: number;
      readonly retryAfterMs?: number;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "ProviderError";
    this.code = code;
    this.providerId = opts.providerId;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
  }

  get transient(): boolean {
    return TRANSIENT_CODES.has(this.code);
  }
}

export function isTransientProviderError(err: unknown): boolean {
  return err instanceof ProviderError && err.transient;
}
