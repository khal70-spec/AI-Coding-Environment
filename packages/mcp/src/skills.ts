// Skill bundles (P6.3, Plan §40/§41): digest whole > sum of parts — registration
// and approval compare the SAME canonical digest, so any post-review mutation
// (content, order, path names) is detected and the skill is blocked mechanically.
import { createHash } from "node:crypto";
import { readdirSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface SkillManifest {
  readonly name: string;
  readonly version?: string;
  readonly permissions: readonly string[];
  readonly sideEffects?: boolean;
  readonly description?: string;
}

export const SKILL_MANIFEST_FILE = "skill.json";
export const MAX_SKILL_BYTES = 512 * 1024;

/** Deterministic canonical digest over (sorted relpath + raw bytes) pairs. */
export function digestSkillBundle(root: string): { sha256: string; files: readonly string[]; error?: string } {
  const files: string[] = [];
  const stack: string[] = [""];
  while (stack.length > 0) {
    const dir = stack.shift() as string;
    let entries: string[];
    try {
      entries = readdirSync(join(root, dir)).sort();
    } catch (err) {
      return { sha256: "", files: Object.freeze(files), error: `unreadable dir: ${err instanceof Error ? err.message : String(err)}` };
    }
    for (const name of entries) {
      const rel = dir === "" ? name : `${dir}/${name}`;
      const abs = join(root, dir, name);
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        return { sha256: "", files: Object.freeze(files), error: `stat failed: ${rel}` };
      }
      if (st.isSymbolicLink()) {
        return { sha256: "", files: Object.freeze(files), error: `symlink refused in bundle: ${rel}` };
      }
      if (st.isDirectory()) {
        stack.push(rel);
        continue;
      }
      if (!st.isFile()) continue;
      files.push(rel);
    }
  }
  const h = createHash("sha256");
  let total = 0;
  for (const rel of files) {
    let buf: Buffer;
    try {
      buf = readFileSync(join(root, rel));
    } catch {
      return { sha256: "", files: Object.freeze(files), error: `read failed: ${rel}` };
    }
    total += buf.length;
    if (total > MAX_SKILL_BYTES) {
      return { sha256: "", files: Object.freeze(files), error: `bundle too large (>${MAX_SKILL_BYTES} bytes)` };
    }
    h.update(rel + "\0");
    h.update(buf);
  }
  return { sha256: h.digest("hex"), files: Object.freeze(files.map((f) => f.split("/").join("/"))) };
}

/** Parse/validate the bundle manifest (skill.json). Pure validation, no execution. */
export function parseSkillManifest(root: string): { manifest?: SkillManifest; errors: readonly string[] } {
  const errors: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(root, SKILL_MANIFEST_FILE), "utf8"));
  } catch (err) {
    return { errors: Object.freeze([`skill.json unreadable: ${err instanceof Error ? err.message : String(err)}`]) };
  }
  const m = parsed as Partial<SkillManifest> | Record<string, unknown>;
  if (typeof m !== "object" || m === null) return { errors: Object.freeze(["skill.json must be an object"]) };
  const mm = m as Record<string, unknown>;
  if (typeof mm["name"] !== "string" || (mm["name"] as string).trim() === "") errors.push("name required");
  if ("version" in mm && typeof mm["version"] !== "string") errors.push("version must be a string");
  if (!Array.isArray(mm["permissions"])) {
    errors.push("permissions array required (explicit grants only)");
  } else {
    for (const p of mm["permissions"] as unknown[]) {
      if (typeof p !== "string" || !/^(fs\.pattern:|net:|tool:|effect:)/.test(p)) {
        errors.push(`invalid permission entry: ${String(p)} (must start fs.pattern:|net:|tool:|effect:)`);
      }
    }
  }
  if (errors.length > 0) return { errors: Object.freeze(errors) };
  return {
    manifest: Object.freeze({
      name: (mm["name"] as string).trim(),
      ...(typeof mm["version"] === "string" ? { version: mm["version"] } : {}),
      permissions: Object.freeze((mm["permissions"] as string[]).slice(0, 128)),
      ...(typeof mm["sideEffects"] === "boolean" ? { sideEffects: mm["sideEffects"] } : {}),
      ...(typeof mm["description"] === "string" ? { description: mm["description"].slice(0, 2000) } : {}),
    }),
    errors: Object.freeze([]),
  };
}

/** Deployment readiness gate (execution surface reads this ONLY). */
export type SkillUseDecision =
  | { readonly ok: true; readonly sha256: string }
  | { readonly ok: false; readonly reason: string };

export function decideSkillUse(rowStatus: "pending_review" | "approved" | "blocked", liveSha: string, recordedSha: string): SkillUseDecision {
  if (rowStatus === "blocked") return Object.freeze({ ok: false, reason: "skill blocked" });
  if (rowStatus !== "approved") return Object.freeze({ ok: false, reason: `status=${rowStatus} (execution requires approved)` });
  if (liveSha === "" || liveSha !== recordedSha) {
    return Object.freeze({ ok: false, reason: "bundle digest mismatch — tamper or moved path (re-review required)" });
  }
  return Object.freeze({ ok: true, sha256: liveSha });
}
