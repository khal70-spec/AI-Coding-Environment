// Unit: classifier, deterministic router, escalation, debate/vote (P5.4).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyTask, routeTask, escalate, debateVote } from "../../../packages/context/src/routing.ts";

const PROVIDERS = [
  { id: "local", name: "lmstudio", protocol: "local-openai-compatible", maxClassification: "restricted", enabled: true },
  { id: "cloud", name: "openai", protocol: "openai", maxClassification: "internal", enabled: true },
  { id: "off", name: "disabled-one", protocol: "openai", maxClassification: "internal", enabled: false },
];

const MODELS = [
  { id: "local:qwen-code-7b", providerId: "local", displayName: "Qwen Coder 7B", verified: true, contextWindow: 32768, status: "available", costPerMtokOut: 0 },
  { id: "local:llama-8b", providerId: "local", displayName: "Llama 3.1 8B Instruct", verified: true, contextWindow: 8192, status: "available", costPerMtokOut: 0 },
  { id: "cloud:gpt-4o", providerId: "cloud", displayName: "gpt-4o", verified: true, contextWindow: 128000, status: "available", costPerMtokOut: 15 },
  { id: "cloud:gpt-4o-mini", providerId: "cloud", displayName: "gpt-4o-mini", verified: true, contextWindow: 128000, status: "available", costPerMtokOut: 0.6 },
  { id: "cloud:unverified-x", providerId: "cloud", displayName: "CodexX", verified: false, contextWindow: 200000, status: "available", costPerMtokOut: 99 },
  { id: "off:dead-model", providerId: "off", displayName: "z", verified: true, contextWindow: 500000, status: "available", costPerMtokOut: 1 },
];

const input = (task, classif = "internal") => ({
  task,
  projectClassification: classif,
  models: MODELS,
  providers: PROVIDERS,
});

describe("classifier", () => {
  it("bucket signals: docs/code/security/ops + risk ladder", () => {
    assert.equal(classifyTask("explain the login flow").kind, "docs");
    assert.equal(classifyTask("fix the type-error in router.ts").kind, "code");
    assert.equal(classifyTask("audit the XSS surface of the settings page").kind, "security");
    assert.equal(classifyTask("run the deploy pipeline for release 2").kind, "ops");
    assert.equal(classifyTask("explain the login flow").risk, "low");
    assert.equal(classifyTask("edit the README to mention ci").risk, "medium");
    assert.equal(classifyTask("drop the users table in production").risk, "high");
    assert.equal(classifyTask("implement a change").mutating, true);
    assert.equal(classifyTask("explain").mutating, false);
  });
});

describe("deterministic router", () => {
  it("restricted data → local-only, regardless of cloud supremacy", () => {
    const d = routeTask(input(classifyTask("fix the password hashing bug"), "restricted"));
    assert.equal(d.providerId, "local");
    assert.equal(d.modelId, "local:qwen-code-7b");
    assert.match(d.rule, /code|high-risk/);
    assert.match(d.rationale, /clearance=restricted/);
  });

  it("code kind on internal → code-named verified model, cloud wins only if name-better? no — code rule picks code-named VERIFIED globally", () => {
    const d = routeTask(input(classifyTask("refactor the repo-index walker")));
    // verified & code-named locally = qwen; cloud unverified code-name excluded
    assert.equal(d.modelId, "local:qwen-code-7b", d.rationale);
    assert.equal(d.rule, "code→code-named-verified");
    assert.ok(!d.candidates.includes("cloud:unverified-x"));
  });

  it("docs kind → smallest adequate verified model (cost irrelevant until tie)", () => {
    const d = routeTask(input(classifyTask("document the CLI surface")));
    assert.equal(d.rule, "docs→smallest-adequate");
    assert.equal(d.modelId, "local:llama-8b", `${d.candidates.length} candidates`);
  });

  it("high risk → largest verified context; costs ignored under risk", () => {
    const d = routeTask(input(classifyTask("wipe the production tenants table (data-loss possible)")));
    assert.equal(d.rule, "high-risk→verified-max-context");
    assert.equal(d.modelId, "cloud:gpt-4o", d.candidates.join(","));
    assert.ok(!d.candidates.includes("cloud:unverified-x"), "unverified never serves high risk");
  });

  it("determinism: byte-identical registry → byte-identical decision (repeated)", () => {
    const t = classifyTask("implement the routing table");
    const a = routeTask(input(t));
    const b = routeTask(input(t, "internal"));
    assert.deepEqual(a, b);
    assert.equal(a.candidates.length >= 1, true);
  });

  it("unavailable lane: confidential+only public-cleared providers → (none) with rationale", () => {
    const d = routeTask({
      task: classifyTask("explain"),
      projectClassification: "confidential",
      models: MODELS,
      providers: [{ id: "pub", name: "p", protocol: "openai", maxClassification: "public", enabled: true }],
    });
    assert.equal(d.modelId, "(none)");
    assert.equal(d.rule, "unavailable");
    assert.match(d.rationale, /no eligible model/);
  });

  it("escalation bumps risk one notch and re-routes deterministically", () => {
    const low = input(classifyTask("explain the login flow"));
    const bumped = escalate(low);
    assert.equal(bumped.task.risk, "medium");
    const twice = escalate(escalate(bumped));
    assert.equal(twice.task.risk, "high"); // saturates
    const d = routeTask(escalate(escalate(low)));
    assert.equal(d.rule, "high-risk→verified-max-context");
  });

  it("disabled-provider models never participate", () => {
    const d = routeTask(input(classifyTask("fix high crypto risk in prod auth")));
    assert.ok(!d.candidates.includes("off:dead-model"));
    assert.notEqual(d.modelId, "off:dead-model");
  });
});

describe("debate/vote", () => {
  it("fenced verdicts: strict majority wins", () => {
    const res = debateVote([
      { model: "a", answer: 'a\n```verdict\n{"choice":"approve"}\n```' },
      { model: "b", answer: 'b\n```verdict\n{"choice":"approve"}\n```' },
      { model: "c", answer: 'c\n```verdict\n{"choice":"reject"}\n```' },
    ]);
    assert.equal(res.winner, "approve");
    assert.deepEqual(res.votes, { approve: 2, reject: 1 });
    assert.equal(res.decidedBy, "fenced-verdict");
    assert.deepEqual(res.tied, []);
  });

  it("keyword fallback when fences missing (decidedBy reflects it)", () => {
    const res = debateVote([
      { model: "a", answer: "I approve this plan" },
      { model: "b", answer: "also approve" },
      { model: "c", answer: "reject — too risky" },
    ]);
    assert.equal(res.winner, "approve");
    assert.equal(res.decidedBy, "keyword-consensus");
  });

  it("ties escalate explicitly, never silently resolved", () => {
    const res = debateVote([
      { model: "a", answer: '```verdict\n{"choice":"yes"}\n```' },
      { model: "b", answer: '```verdict\n{"choice":"no"}\n```' },
    ]);
    assert.equal(res.winner, "(escalate)");
    assert.equal(res.decidedBy, "tie→escalate");
    assert.deepEqual([...res.tied].sort(), ["no", "yes"]);
  });

  it("empty/valuenothing exchanges escalate deterministically", () => {
    const res = debateVote([{ model: "a", answer: "asdf" }, { model: "b", answer: "zzz" }]);
    assert.equal(res.winner, "(escalate)");
  });
});
