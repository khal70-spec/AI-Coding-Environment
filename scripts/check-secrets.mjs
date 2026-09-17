// check-secrets.mjs — Phase 0 lightweight secret scanner.
// Fails closed: any probable secret in tracked text files fails CI.
// Complements Gitleaks in CI; runs offline with zero dependencies.
// Usage: npm run check:secrets
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Keep aligned with .gitleaks.toml — only pattern definitions + declared fixture files.
const ALLOWLIST_FILES = new Set([
  "scripts/check-secrets.mjs",
  "packages/security/src/secret-patterns.ts",
  "tests/security/secret-redaction.test.mjs",
  "docs/security/secret-policy.md",
]);

// Patterns intentionally match REAL secret shapes; fixtures must use
// obviously-fake markers (e.g. EXAMPLE, TESTONLY, <redacted>) — see secret-policy.md.
const PATTERNS = [
  { name: "openai-key", re: /\bsk-(proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { name: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{10,}\b/ },
  { name: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "aws-secret", re: /\baws_secret_access_key\b\s*[:=]\s*\S+/i },
  { name: "private-key-block", re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "github-token", re: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/ },
  { name: "generic-api-key-assign", re: /\b(api[_-]?key|api[_-]?secret|access[_-]?token)\b\s*[:=]\s*["']?[A-Za-z0-9_\-./+]{16,}["']?/i },
  { name: "connection-string-secret", re: /\b(password|passwd|pwd)\b\s*[:=]\s*["']?\S{4,}["']?/i },
];

const BINARY_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2", ".ttf", ".eot", ".pdf", ".zip", ".gz"]);

function trackedFiles() {
  try {
    const out = execSync("git ls-files -z", { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 });
    return out.toString("utf8").split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

const files = trackedFiles().filter(
  (f) => !f.startsWith("node_modules/") && !f.startsWith(".git/") && ![...BINARY_EXT].some((e) => f.endsWith(e))
);

let findings = 0;
for (const file of files) {
  if (ALLOWLIST_FILES.has(file)) continue;
  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  const lines = content.split("\n");
  lines.forEach((line, i) => {
    // Skip documented fake-marker lines and markdown code fences describing patterns.
    if (/EXAMPLE|TESTONLY|<redacted>|\*\*\*|your[_-]?key[_-]?here|xxxx/i.test(line)) return;
    for (const { name, re } of PATTERNS) {
      if (re.test(line)) {
        console.error(`SECRET? [${name}] ${file}:${i + 1}: ${line.trim().slice(0, 120)}`);
        findings++;
        break;
      }
    }
  });
}

if (findings > 0) {
  console.error(`\ncheck:secrets FAILED — ${findings} probable secret(s). Remove them, use fixtures with EXAMPLE/TESTONLY markers, and rotate any real credential.`);
  process.exit(1);
}
console.log(`check:secrets OK — scanned ${files.length} tracked files, no probable secrets.`);
