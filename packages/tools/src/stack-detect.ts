// Stack detection — Plan §22 (P3.3). Read-only project sniffing inside the jail:
// answers "which ecosystem is this, and what argv runs its test suite?".
// The mapping here is the ONLY allowlist test.exec will ever run (T10).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { assertContainedSync } from "../../security/src/paths.ts";

export type StackKind = "node" | "python" | "dotnet" | "rust" | "go" | "php" | "unknown";

export interface StackInfo {
  readonly kind: StackKind;
  /** Which marker convinced us (diag + audit). */
  readonly marker: string | null;
  /** Allowlisted test argv for this stack, or null when unknown. */
  readonly testArgv: readonly string[] | null;
}

type MarkerRule = {
  readonly kind: Exclude<StackKind, "unknown">;
  readonly marker: string;
  readonly testArgv: readonly string[];
};

function nodeTestArgv(root: string): readonly string[] {
  // package.json scripts.test wins over the npm default ("npm test" already runs it,
  // but being explicit keeps the allowlist auditable).
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    if (typeof pkg?.name === "string" && pkg?.scripts && typeof pkg.scripts.test === "string") {
      return ["npm", "test"];
    }
  } catch {
    /* unparsable package.json — fall through to npm test anyway */
  }
  return ["npm", "test"];
}

function hasAnyFile(root: string, test: (name: string) => boolean): string | null {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return null;
  }
  return names.find(test) ?? null;
}

/** Ordered: first positive marker wins. */
export function detectStack(jailRoot: string): StackInfo {
  // Containment first — even detection never leaves the jail.
  const contained = assertContainedSync(jailRoot, ".");
  if (!contained.ok) return { kind: "unknown", marker: null, testArgv: null };
  const root = contained.path;

  if (existsSync(join(root, "package.json"))) {
    return { kind: "node", marker: "package.json", testArgv: nodeTestArgv(root) };
  }
  for (const m of ["requirements.txt", "requirements-dev.txt", "pyproject.toml", "setup.py", "Pipfile"]) {
    if (existsSync(join(root, m))) {
      // pytest if the marker existing hints a modern project; unittest module as fallback argv
      return { kind: "python", marker: m, testArgv: ["python3", "-m", "pytest"] };
    }
  }
  const csproj = hasAnyFile(root, (n) => /\.csproj$|\.sln$/i.test(n));
  if (csproj !== null) {
    return { kind: "dotnet", marker: csproj, testArgv: ["dotnet", "test"] };
  }
  if (existsSync(join(root, "Cargo.toml"))) {
    return { kind: "rust", marker: "Cargo.toml", testArgv: ["cargo", "test"] };
  }
  if (existsSync(join(root, "go.mod"))) {
    return { kind: "go", marker: "go.mod", testArgv: ["go", "test", "./..."] };
  }
  if (existsSync(join(root, "composer.json"))) {
    return { kind: "php", marker: "composer.json", testArgv: ["composer", "test"] };
  }
  return { kind: "unknown", marker: null, testArgv: null };
}

export const STACK_TEST_COMMANDS: Readonly<Record<Exclude<StackKind, "unknown">, readonly string[]>> =
  Object.freeze({
    node: ["npm", "test"],
    python: ["python3", "-m", "pytest"],
    dotnet: ["dotnet", "test"],
    rust: ["cargo", "test"],
    go: ["go", "test", "./..."],
    php: ["composer", "test"],
  });

export type { MarkerRule };
