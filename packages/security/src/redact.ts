// Redaction — applied to tool output, model input, logs, audit fields, UI strings.
// Fail-closed helper: `containsSecret` gates sends; `redact` sanitizes display/storage.
import { SECRET_PATTERNS, redactionToken } from "./secret-patterns.ts";

export interface RedactionResult {
  readonly text: string;
  readonly hits: readonly string[];
  readonly redacted: boolean;
}

function freshRe(patternId: string): RegExp {
  const found = SECRET_PATTERNS.find((x) => x.id === patternId);
  if (found === undefined) throw new Error(`unknown secret pattern: ${patternId}`);
  return new RegExp(found.re.source, found.re.flags);
}

export function redact(input: string): RedactionResult {
  let text = input;
  const hits: string[] = [];
  for (const pattern of SECRET_PATTERNS) {
    const re = freshRe(pattern.id); // global regexes are stateful — never reuse
    if (re.test(text)) {
      hits.push(pattern.id);
      re.lastIndex = 0;
      text = text.replace(re, redactionToken(pattern.id));
    }
  }
  return { text, hits: Object.freeze([...hits]), redacted: hits.length > 0 };
}

/** True when the text appears to contain a secret. Use before any provider send. */
export function containsSecret(input: string): boolean {
  return SECRET_PATTERNS.some((pattern) => freshRe(pattern.id).test(input));
}

/** Which rules fired (ids only — safe to log). */
export function detectSecretKinds(input: string): readonly string[] {
  return Object.freeze(
    SECRET_PATTERNS.filter((pattern) => freshRe(pattern.id).test(input)).map(
      (pattern) => pattern.id,
    ),
  );
}
