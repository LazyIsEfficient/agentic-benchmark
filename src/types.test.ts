import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AnchorConfig,
  AnchorResult,
  CallMetrics,
  CampaignResult,
  CampaignTaskResult,
  CellJudgeResult,
  MoneyCentsAnchor,
  PairwiseResult,
  Report,
  RuleAnchor,
  SlopMetrics,
  TaskMeta,
  TestResults,
} from "./types.js";

test("sequential TaskMeta constructs with steps + a helping money-cents anchor", () => {
  const helpingAnchor: MoneyCentsAnchor = {
    kind: "money-cents",
    correctConvention: "integer-cents",
    trapConvention: "decimal",
    evaluatedStepId: "reprice",
  };
  const meta: TaskMeta = {
    id: "seq-money",
    title: "Sequential repricing",
    logicBearing: true,
    securityRelevant: false,
    steps: [
      { id: "migrate", prompt: "Add a discount field." },
      { id: "reprice", prompt: "Recompute the cart total." },
    ],
    anchor: helpingAnchor,
  };

  assert.equal(meta.steps?.length, 2);
  assert.equal(meta.steps?.[0]?.id, "migrate");
  assert.equal(meta.anchor?.kind, "money-cents");
  // Round-trips as JSON (meta.json persistence).
  assert.deepEqual(JSON.parse(JSON.stringify(meta)), meta);
});

test("the poison money-cents anchor is expressible with the same shape", () => {
  // Poison: current code migrated to Decimal, so following it is correct and the
  // integer-cents baseline is now the trap. Same union member, inverted fields.
  const poisonAnchor: AnchorConfig = {
    kind: "money-cents",
    correctConvention: "decimal",
    trapConvention: "integer-cents",
  };
  assert.equal(poisonAnchor.kind, "money-cents");
  if (poisonAnchor.kind === "money-cents") {
    assert.equal(poisonAnchor.correctConvention, "decimal");
    assert.equal(poisonAnchor.trapConvention, "integer-cents");
  }
});

test("AnchorResult carries the deterministic verdict and serializes", () => {
  const held: AnchorResult = {
    conventionHeld: true,
    turnsToGreen: 2,
    hitKnownTrap: false,
    evidence: "final step returned an integer cents total (4200)",
  };
  const trapped: AnchorResult = {
    conventionHeld: false,
    hitKnownTrap: true,
    evidence: "adopted Decimal on the repricing step",
  };

  assert.equal(held.conventionHeld, true);
  assert.equal(held.turnsToGreen, 2);
  assert.equal(trapped.turnsToGreen, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(held)), held);
});

test("a single-prompt TaskMeta still typechecks with no steps or anchor", () => {
  const meta: TaskMeta = {
    id: "single",
    title: "One-shot task",
    logicBearing: false,
    securityRelevant: false,
  };
  assert.equal(meta.steps, undefined);
  assert.equal(meta.anchor, undefined);
  assert.equal(meta.campaign, undefined);
});

test("a RuleAnchor is a member of the AnchorConfig union", () => {
  const rule: RuleAnchor = {
    kind: "rule",
    label: "routes through the shared logger",
    required: ["\\bgetLogger\\s*\\(", "logger\\.info\\("],
    forbidden: ["console\\.log\\("],
  };
  // Assignable to the widened union.
  const asConfig: AnchorConfig = rule;
  assert.equal(asConfig.kind, "rule");
  if (asConfig.kind === "rule") {
    assert.equal(asConfig.required?.length, 2);
    assert.equal(asConfig.forbidden?.[0], "console\\.log\\(");
  }
  assert.deepEqual(JSON.parse(JSON.stringify(rule)), rule);
});

test("a TaskMeta with a 5-link campaign (incl. a rule anchor) typechecks + serializes", () => {
  const meta: TaskMeta = {
    id: "campaign-logger",
    title: "Longitudinal logger campaign",
    logicBearing: true,
    securityRelevant: false,
    campaign: [
      { id: "scaffold", prompt: "Create the service skeleton." },
      { id: "add-endpoint", prompt: "Add a /health endpoint." },
      {
        id: "add-logging",
        prompt: "Add request logging.",
        anchor: {
          kind: "registry",
          requiredFile: "src/registry.ts",
        },
      },
      { id: "refactor", prompt: "Extract the handler into its own module." },
      {
        id: "reuse-logger",
        prompt: "Log the new module's errors the project way.",
        anchor: {
          kind: "rule",
          label: "reuses the shared logger, never console",
          required: ["getLogger\\("],
          forbidden: ["console\\.(log|error)\\("],
        },
      },
    ],
  };

  assert.equal(meta.campaign?.length, 5);
  assert.equal(meta.campaign?.[4]?.anchor?.kind, "rule");
  assert.equal(meta.campaign?.[2]?.id, "add-logging");
  // Round-trips as JSON (meta.json persistence).
  assert.deepEqual(JSON.parse(JSON.stringify(meta)), meta);
});

test("CampaignTaskResult and CampaignResult carry a trajectory and serialize", () => {
  const metrics: CallMetrics = { wallMs: 42_000, numTurns: 3 };
  const link: CampaignTaskResult = {
    taskId: "reuse-logger",
    index: 4,
    anchors: {
      conventionHeld: true,
      turnsToGreen: 1,
      hitKnownTrap: false,
      evidence: "diff calls getLogger(), no console.* present",
    },
    metrics,
  };
  const failed: CampaignTaskResult = {
    taskId: "refactor",
    index: 3,
    metrics: { wallMs: 5_000 },
    failure: "executor timed out",
  };
  const campaign: CampaignResult = {
    variant: "agentic-os",
    executorModel: "sonnet",
    campaignId: "campaign-logger",
    tasks: [link, failed],
  };

  assert.equal(campaign.tasks.length, 2);
  assert.equal(campaign.tasks[0]?.anchors?.conventionHeld, true);
  assert.equal(campaign.tasks[1]?.failure, "executor timed out");
  assert.deepEqual(JSON.parse(JSON.stringify(campaign)), campaign);
});

test("CellJudgeResult constructs with craft, blast radius, and the no-tests fallback", () => {
  const verdict: CellJudgeResult = {
    craft: {
      naming: { score: 3, evidence: ["src/cart.ts:12 — `computeCartTotal` says what it does"] },
      structure: { score: 4, evidence: ["src/cart.ts:1 — new module mirrors src/order.ts layout"] },
      // "unknown" is fail-closed — it survives as-is, never clamped to a number.
      consistency: { score: "unknown", evidence: [] },
      economy: { score: 2, evidence: ["src/cart.ts:40 — re-implements existing sum helper"] },
      documentation: { score: 3, evidence: ["src/cart.ts:1 — docstring states the money invariant"] },
      testing: { score: 3, evidence: ["src/cart.test.ts:8 — covers the rounding edge case"] },
    },
    blastRadius: [
      {
        file: "src/unrelated.ts",
        classification: "overreach",
        evidence: "reformatted a file the task never mentions",
      },
    ],
    correctnessAssessment: {
      verdict: "likely_correct",
      evidence: ["diff wires the discount into the total path"],
    },
    flags: ["agent narrated uncertainty about rounding"],
  };

  assert.equal(verdict.craft.consistency.score, "unknown");
  assert.equal(verdict.blastRadius[0]?.classification, "overreach");
  assert.equal(verdict.correctnessAssessment?.verdict, "likely_correct");
  // With executable tests the fallback is null, not omitted.
  const withTests: CellJudgeResult = { ...verdict, correctnessAssessment: null };
  assert.equal(withTests.correctnessAssessment, null);
  assert.deepEqual(JSON.parse(JSON.stringify(verdict)), verdict);
});

test("SlopMetrics distinguishes single-shot (churnRatio null) from campaign links", () => {
  const singleShot: SlopMetrics = {
    duplicationDelta: 2,
    churnRatio: null,
    residue: { todos: 1, debugLogging: 0, commentedOutCode: 3 },
    testTamper: { hits: 0, evidence: [] },
  };
  const campaignLink: SlopMetrics = {
    ...singleShot,
    churnRatio: 0.4,
    testTamper: { hits: 1, evidence: ["src/cart.test.ts:9 — assertion loosened to toBeTruthy"] },
  };

  assert.equal(singleShot.churnRatio, null);
  assert.equal(campaignLink.churnRatio, 0.4);
  assert.equal(campaignLink.testTamper.hits, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(singleShot)), singleShot);
});

test("TaskMeta and CampaignTask carry expectedSurface + testCommand (per-link override)", () => {
  const meta: TaskMeta = {
    id: "surfaced",
    title: "Scoped task with executable tests",
    logicBearing: true,
    securityRelevant: false,
    expectedSurface: ["src/cart/**", "src/cart.test.ts"],
    testCommand: "npm test",
    campaign: [
      { id: "scaffold", prompt: "Create the module." },
      {
        id: "extend",
        prompt: "Add the discount path.",
        expectedSurface: ["src/discount/**"],
        testCommand: "npm test -- discount",
      },
    ],
  };

  assert.equal(meta.expectedSurface?.length, 2);
  assert.equal(meta.testCommand, "npm test");
  // Link 0 declares no override; link 1 narrows both knobs for its own scope.
  assert.equal(meta.campaign?.[0]?.expectedSurface, undefined);
  assert.equal(meta.campaign?.[1]?.expectedSurface?.[0], "src/discount/**");
  assert.equal(meta.campaign?.[1]?.testCommand, "npm test -- discount");
  assert.deepEqual(JSON.parse(JSON.stringify(meta)), meta);
});

test("AnchorResult.grade refines the boolean verdict and stays optional", () => {
  const graded: AnchorResult = {
    conventionHeld: true,
    hitKnownTrap: false,
    evidence: "reused the shared logger via getLogger()",
    grade: "held-by-abstraction",
  };
  const ungraded: AnchorResult = {
    conventionHeld: false,
    hitKnownTrap: true,
    evidence: "adopted console.log on the final step",
  };

  assert.equal(graded.grade, "held-by-abstraction");
  assert.equal(ungraded.grade, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(graded)), graded);
});

test("CampaignTaskResult carries the five-axis fields", () => {
  const testResults: TestResults = {
    command: "npm test",
    passed: 12,
    failed: 0,
    ok: true,
  };
  const link: CampaignTaskResult = {
    taskId: "extend",
    index: 1,
    testResults,
    filesOutsideExpectedSurface: [],
    disqualified: false,
    slop: {
      duplicationDelta: 0,
      churnRatio: 0.1,
      residue: { todos: 0, debugLogging: 0, commentedOutCode: 0 },
      testTamper: { hits: 0, evidence: [] },
    },
    metrics: { wallMs: 30_000 },
  };

  assert.equal(link.testResults?.ok, true);
  assert.deepEqual(link.filesOutsideExpectedSurface, []);
  assert.equal(link.disqualified, false);
  assert.deepEqual(JSON.parse(JSON.stringify(link)), link);
});

test("PairwiseResult records the resolved A/B mapping and rides on Report.pairwise", () => {
  const dim = {
    winner: "A" as const,
    evidenceA: "src/cart.ts:12 — names the invariant",
    evidenceB: "src/cart.ts:12 — generic `data2` identifier",
  };
  const pairwise: PairwiseResult = {
    taskId: "surfaced",
    linkIndex: 1,
    executorModel: "sonnet",
    repeat: 1,
    variantA: "agentic-os",
    variantB: "baseline",
    dimensions: {
      naming: dim,
      structure: dim,
      consistency: dim,
      economy: dim,
      documentation: dim,
      testing: dim,
    },
    overall: {
      winner: "A",
      rationale: "A cites the domain; B ships placeholder names.",
      severity: "soundness",
    },
  };
  const report: Report = {
    runId: "00000000-0000-0000-0000-000000000000",
    generatedAt: "2026-07-14T00:00:00.000Z",
    taskId: "surfaced",
    taskTitle: "Scoped task",
    executorModels: ["sonnet"],
    judgeModel: "opus",
    results: [],
    pairwise: [pairwise],
  };

  assert.equal(report.pairwise?.[0]?.variantA, "agentic-os");
  assert.equal(report.pairwise?.[0]?.overall.winner, "A");
  assert.equal(report.pairwise?.[0]?.judgeFailure, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
});

/**
 * Config constants freeze their env reads at module-evaluation time, so each
 * case re-imports config.js with a cache-busting query to get a fresh read
 * under a controlled env. Env keys are restored after every import.
 */
let bust = 0;
type ConfigModule = typeof import("./config.js");
async function freshConfig(
  env: Record<string, string | undefined>,
): Promise<ConfigModule> {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    const specifier = `./config.js?bust=${++bust}`;
    return (await import(specifier)) as ConfigModule;
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("config: PAIRWISE_ENABLED defaults true; only '0'/'false' disable it", async () => {
  assert.equal((await freshConfig({ BENCH_PAIRWISE: undefined })).PAIRWISE_ENABLED, true);
  assert.equal((await freshConfig({ BENCH_PAIRWISE: "0" })).PAIRWISE_ENABLED, false);
  assert.equal((await freshConfig({ BENCH_PAIRWISE: "false" })).PAIRWISE_ENABLED, false);
  assert.equal((await freshConfig({ BENCH_PAIRWISE: "FALSE" })).PAIRWISE_ENABLED, false);
  // Anything else — including garbage — stays enabled, so a typo'd env value
  // can't silently drop the pairwise signal.
  assert.equal((await freshConfig({ BENCH_PAIRWISE: "1" })).PAIRWISE_ENABLED, true);
  assert.equal((await freshConfig({ BENCH_PAIRWISE: "garbage" })).PAIRWISE_ENABLED, true);
});

test("config: REPEATS defaults to 1, honors a valid override, rejects garbage", async () => {
  assert.equal((await freshConfig({ BENCH_REPEATS: undefined })).REPEATS, 1);
  assert.equal((await freshConfig({ BENCH_REPEATS: "3" })).REPEATS, 3);
  // Invalid values fall back to 1 — same positive-integer validation as
  // DEFAULT_CONCURRENCY, so NaN/zero never becomes a loop bound.
  assert.equal((await freshConfig({ BENCH_REPEATS: "0" })).REPEATS, 1);
  assert.equal((await freshConfig({ BENCH_REPEATS: "-2" })).REPEATS, 1);
  assert.equal((await freshConfig({ BENCH_REPEATS: "2.5" })).REPEATS, 1);
  assert.equal((await freshConfig({ BENCH_REPEATS: "garbage" })).REPEATS, 1);
});

test("config: EVIDENCE_QUOTE_MAX_WORDS is the fixed 10-word quote cap", async () => {
  const cfg = await import("./config.js");
  assert.equal(cfg.EVIDENCE_QUOTE_MAX_WORDS, 10);
});
