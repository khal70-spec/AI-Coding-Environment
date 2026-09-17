// Result type — explicit success/failure, no thrown control flow in kernels.
// Plan §3.8 (fail closed): failures carry machine-readable codes + remediation.

export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Fail<E = KernelError> {
  readonly ok: false;
  readonly error: E;
}

export type Result<T, E = KernelError> = Ok<T> | Fail<E>;

export interface KernelError {
  readonly code: string;
  readonly message: string;
  readonly remediation?: string;
}

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function fail(code: string, message: string, remediation?: string): Fail {
  return { ok: false, error: { code, message, remediation } };
}

export function isOk<T>(r: Result<T>): r is Ok<T> {
  return r.ok === true;
}
