// Secret shapes — Plan §11/§15, ADR-006.
// NOTE: this file defines *detection patterns* for REDACTION. It is allowlisted from
// secret scanners (see scripts/check-secrets.mjs + .gitleaks.toml) because regexes
// necessarily resemble secrets. Never add a real credential here.

export interface SecretPattern {
  readonly id: string;
  readonly re: RegExp;
  readonly description: string;
}

function p(id: string, source: string, flags: string, description: string): SecretPattern {
  return { id, re: new RegExp(source, flags), description };
}

export const SECRET_PATTERNS: readonly SecretPattern[] = Object.freeze([
  p("openai", "\\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\\b", "g", "OpenAI-style key"),
  p("anthropic", "\\bsk-ant-[A-Za-z0-9_-]{10,}\\b", "g", "Anthropic-style key"),
  p("aws-access", "\\bAKIA[0-9A-Z]{16}\\b", "g", "AWS access key id"),
  p("aws-secret", "\\baws_secret_access_key[\"']?\\s*[:=]\\s*\\S+", "gi", "AWS secret assignment"),
  p("github-token", "\\bgh[pousr]_[A-Za-z0-9_]{20,}\\b", "g", "GitHub token"),
  p("gitlab-token", "\\bglpat-[A-Za-z0-9_.-]{10,}\\b", "g", "GitLab token"),
  p("google-api", "\\bAIza[0-9A-Za-z_\\-]{30,}\\b", "g", "Google API key"),
  p("slack-token", "\\bxox[baprs]-[A-Za-z0-9-]{10,}\\b", "g", "Slack token"),
  p("jwt", "\\beyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\b", "g", "JWT"),
  p("pem-block", "-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----", "g", "PEM private key header"),
  p(
    "generic-assign",
    "\\b(?:api[_-]?key|api[_-]?secret|access[_-]?token|auth[_-]?token|client[_-]?secret)\\b\\s*[:=]\\s*[\"']?[A-Za-z0-9_\\-./+]{12,}[\"']?",
    "gi",
    "generic key/token assignment",
  ),
  p(
    "password-assign",
    "\\b(?:password|passwd|pwd)\\b\\s*[:=]\\s*[\"']?\\S{4,}[\"']?",
    "gi",
    "password assignment",
  ),
  p(
    "connection-string",
    "\\b(?:mongodb(?:\\+srv)?|postgres(?:ql)?|mysql|redis(?:s)?|amqp(?:s)?)://[^\\s\"']+",
    "gi",
    "connection string with possible credentials",
  ),
  p("bearer", "\\bBearer\\s+[A-Za-z0-9_\\-./+=]{16,}\\b", "g", "Bearer token"),
]);

/** Replacement token. The id names the rule, never the value. */
export function redactionToken(patternId: string): string {
  return `[REDACTED:${patternId}]`;
}
