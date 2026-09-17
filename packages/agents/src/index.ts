// @ai-coding-env/agents — Plan §7/§8, ADR-003.
// Declarative, versioned permission manifests. The policy engine enforces them;
// agents can NEVER modify their own manifest (no-self-modify is structural: there is
// no tool that writes manifests, and reviewer agents cannot weaken protections).
import type { DataClassification, RiskLevel } from "../../core/src/index.ts";
import type { AgentGrant } from "../../policy/src/index.ts";

export type AgentName =
  | "orchestrator"
  | "investigator"
  | "architect"
  | "implementer"
  | "tester"
  | "security-reviewer"
  | "code-reviewer"
  | "docs"
  | "release";

export interface PermissionManifest {
  readonly agent: AgentName;
  readonly version: 1;
  readonly description: string;
  readonly grant: AgentGrant;
}

/** Canonical tool vocabulary. Unknown tools are denied by the policy engine. */
export const KNOWN_TOOLS: readonly string[] = Object.freeze([
  "fs.read",
  "fs.write",
  "fs.delete",
  "search.exact",
  "search.semantic",
  "terminal.run",
  "git.read",
  "git.checkpoint",
  "git.worktree",
  "git.merge",
  "tests.run",
  "security.scan",
  "browser.run",
  "context.assemble",
  "memory.read",
  "memory.write",
  "mcp.call",
]);

function grant(
  toolsAllow: readonly string[],
  opts: Partial<AgentGrant> & { maxRisk: RiskLevel; maxClassification: DataClassification },
): AgentGrant {
  return {
    toolsAllow,
    toolsDeny: [],
    fsRead: "project",
    fsWrite: "none",
    terminal: "none",
    networkDefault: "deny",
    networkAllow: [],
    ...opts,
  };
}

export const BUILTIN_MANIFESTS: Readonly<Record<AgentName, PermissionManifest>> = Object.freeze({
  orchestrator: {
    agent: "orchestrator",
    version: 1,
    description: "Coordinates tasks; delegates effects to specialized agents.",
    grant: grant(["context.assemble", "memory.read", "memory.write", "git.read"], {
      maxRisk: "medium",
      maxClassification: "confidential",
    }),
  },
  investigator: {
    agent: "investigator",
    version: 1,
    description: "Read-only inspection (default).",
    grant: grant(["fs.read", "search.exact", "search.semantic", "git.read", "context.assemble"], {
      fsRead: "project",
      fsWrite: "none",
      maxRisk: "low",
      maxClassification: "confidential",
    }),
  },
  architect: {
    agent: "architect",
    version: 1,
    description: "Designs solutions; reads project, writes plan artifacts to workspace.",
    grant: grant(["fs.read", "search.exact", "search.semantic", "git.read", "fs.write"], {
      fsRead: "project",
      fsWrite: "workspace",
      maxRisk: "low",
      maxClassification: "confidential",
    }),
  },
  implementer: {
    agent: "implementer",
    version: 1,
    description: "Modifies approved files in the task workspace.",
    grant: grant(
      ["fs.read", "fs.write", "search.exact", "search.semantic", "terminal.run", "git.read", "git.checkpoint", "tests.run"],
      { fsRead: "project", fsWrite: "workspace", terminal: "approved_commands", maxRisk: "medium", maxClassification: "internal" },
    ),
  },
  tester: {
    agent: "tester",
    version: 1,
    description: "Runs suites, analyzes failures, adds tests where authorized.",
    grant: grant(["fs.read", "fs.write", "terminal.run", "git.read", "tests.run"], {
      fsRead: "project",
      fsWrite: "workspace",
      terminal: "approved_commands",
      maxRisk: "medium",
      maxClassification: "internal",
    }),
  },
  "security-reviewer": {
    agent: "security-reviewer",
    version: 1,
    description: "Inspects for vulnerabilities; cannot weaken protections.",
    grant: grant(["fs.read", "search.exact", "search.semantic", "git.read", "security.scan", "tests.run"], {
      fsRead: "project",
      fsWrite: "none",
      maxRisk: "low",
      maxClassification: "restricted",
    }),
  },
  "code-reviewer": {
    agent: "code-reviewer",
    version: 1,
    description: "Independent final-diff review; read-only.",
    grant: grant(["fs.read", "git.read", "search.exact"], {
      fsRead: "project",
      fsWrite: "none",
      maxRisk: "low",
      maxClassification: "confidential",
    }),
  },
  docs: {
    agent: "docs",
    version: 1,
    description: "Updates documentation only when authorized.",
    grant: grant(["fs.read", "fs.write", "search.exact"], {
      fsRead: "project",
      fsWrite: "workspace",
      maxRisk: "low",
      maxClassification: "internal",
    }),
  },
  release: {
    agent: "release",
    version: 1,
    description: "Prepares release artifacts; cannot deploy.",
    grant: grant(["fs.read", "git.read", "tests.run"], {
      fsRead: "project",
      fsWrite: "none",
      maxRisk: "low",
      maxClassification: "internal",
    }),
  },
});

/** Validate a manifest (used at load + in tests). Returns error strings, empty = valid. */
export function validateManifest(m: PermissionManifest): readonly string[] {
  const errors: string[] = [];
  if (m.version !== 1) errors.push(`unsupported manifest version: ${String(m.version)}`);
  for (const t of [...m.grant.toolsAllow, ...m.grant.toolsDeny]) {
    if (t !== "*" && !KNOWN_TOOLS.includes(t)) errors.push(`unknown tool: ${t}`);
  }
  if (m.grant.terminal === "full") errors.push("terminal: full is never granted to agents");
  if (m.grant.networkDefault === "allow") errors.push("network default allow is forbidden");
  if (m.agent !== "orchestrator" && m.grant.toolsAllow.includes("*")) {
    errors.push("wildcard tool grant is forbidden for non-orchestrator agents");
  }
  if (m.grant.fsWrite === "project") errors.push("project-wide write is forbidden (workspace only)");
  return Object.freeze(errors);
}
