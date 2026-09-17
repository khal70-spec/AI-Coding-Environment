// Path containment — Plan §19 Level 1 sandbox, threat T9.
// Every filesystem tool resolves the target then proves containment in the workspace root.
import { realpathSync } from "node:fs";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";

export interface ContainmentError {
  readonly code: "PATH_ESCAPE" | "PATH_INVALID";
  readonly message: string;
}

/** Lexical containment: is `candidate` (absolute or root-relative) inside `root`? */
export function isWithinRoot(root: string, candidate: string): boolean {
  const absRoot = resolve(root);
  const absTarget = isAbsolute(candidate) ? normalize(candidate) : resolve(absRoot, candidate);
  if (absTarget === absRoot) return true;
  const rel = relative(absRoot, absTarget);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

/**
 * Resolve `target` against workspace `root` and return the absolute path, or a
 * ContainmentError when it escapes / is invalid. Pure lexical check (no I/O).
 */
export function resolveWithinRoot(
  root: string,
  target: string,
): { ok: true; path: string } | { ok: false; error: ContainmentError } {
  if (typeof target !== "string" || target.length === 0 || target.includes("\0")) {
    return { ok: false, error: { code: "PATH_INVALID", message: "empty or NUL-containing path" } };
  }
  // Reject backslashes outright: on Windows they are separators (escape vector),
  // on posix they invite separator-confusion bugs. Use forward slashes.
  if (target.includes("\\")) {
    return { ok: false, error: { code: "PATH_INVALID", message: "backslash in path rejected" } };
  }
  // Reject Windows device paths and UNC even on posix hosts (defense in depth).
  if (/^([a-zA-Z]:[\\/]|CON|PRN|AUX|NUL|COM\d|LPT\d)/i.test(target.trim())) {
    return { ok: false, error: { code: "PATH_INVALID", message: "device/UNC path rejected" } };
  }
  const absRoot = resolve(root);
  const absTarget = isAbsolute(target) ? normalize(target) : resolve(absRoot, target);
  if (!isWithinRoot(absRoot, absTarget)) {
    return { ok: false, error: { code: "PATH_ESCAPE", message: `path escapes workspace root: ${target}` } };
  }
  return { ok: true, path: absTarget };
}

/**
 * I/O-backed containment: resolves symlinks on both sides. Use before any write/delete
 * of an existing path. Missing paths fall back to lexical check of the real parent.
 */
export function assertContainedSync(
  root: string,
  target: string,
): { ok: true; path: string } | { ok: false; error: ContainmentError } {
  const lexical = resolveWithinRoot(root, target);
  if (!lexical.ok) return lexical;
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return { ok: false, error: { code: "PATH_INVALID", message: "workspace root does not exist" } };
  }
  try {
    const realTarget = realpathSync(lexical.path);
    if (!isWithinRoot(realRoot, realTarget)) {
      return { ok: false, error: { code: "PATH_ESCAPE", message: "symlink escapes workspace root" } };
    }
    return { ok: true, path: realTarget };
  } catch {
    // Target missing: containment of the lexical path already proven above.
    return { ok: true, path: lexical.path };
  }
}
