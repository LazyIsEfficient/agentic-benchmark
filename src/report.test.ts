import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  aggregateCorrectness,
  aggregateCraft,
  aggregateMetrics,
  aggregatePairwise,
  aggregateReliability,
  aggregateSlop,
  buildCampaignMemoryEffect,
  buildMemoryEffect,
  buildReportJson,
  cellText,
  distinctModels,
  excludedReasonOf,
  formatScore,
  gradeSymbol,
  hasMemoryEffect,
  isScored,
  regenerateReport,
  renderBehaviorComparison,
  renderBlastRadius,
  renderCampaignMemoryEffect,
  renderCorrectness,
  renderCraft,
  renderExcludedCells,
  renderJudgeCraft,
  renderMemoryEffect,
  renderPairwise,
  renderReliability,
  renderReportMarkdown,
  renderRunMetrics,
  renderSlop,
} from "./report.js";
import type {
  AnchorResult,
  Behavior,
  CampaignResult,
  CampaignTaskResult,
  CellCraft,
  CellJudgeResult,
  CraftDimension,
  CraftScore,
  CraftScoreValue,
  PairwiseDimension,
  PairwiseResult,
  PairwiseWinner,
  Report,
  RunMetrics,
  SlopMetrics,
  TestResults,
  VariantTaskResult,
} from "./types.js";

/** Minimal five-axis cell; everything beyond identity + metrics via `extra`. */
function cell(
  variant: string,
  taskId: string,
  extra: Partial<VariantTaskResult> = {},
): VariantTaskResult {
  return {
    cellId: `${taskId}__${variant}__sonnet`,
    variant,
    taskId,
    executorModel: "sonnet",
    judgeModel: "opus",
    metrics: {
      executor: {
        wallMs: 10_000,
        costUsd: 0.05,
        numTurns: 3,
        usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheCreateTokens: 0 },
      },
      judge: { wallMs: 5000, costUsd: 0.02 },
    } satisfies RunMetrics,
    ...extra,
  };
}

function craftScores(
  overrides: Partial<Record<CraftDimension, CraftScoreValue>> = {},
): CellCraft {
  const score = (v: CraftScoreValue): CraftScore => ({
    score: v,
    evidence: ["src/a.ts:1 — short quote"],
  });
  return {
    naming: score(overrides.naming ?? 3),
    structure: score(overrides.structure ?? 3),
    consistency: score(overrides.consistency ?? 3),
    economy: score(overrides.economy ?? 3),
  };
}

function judgeResult(extra: Partial<CellJudgeResult> = {}): CellJudgeResult {
  return {
    craft: craftScores(),
    blastRadius: [],
    correctnessAssessment: null,
    flags: [],
    ...extra,
  };
}

function slopMetrics(extra: Partial<SlopMetrics> = {}): SlopMetrics {
  return {
    duplicationDelta: 0,
    churnRatio: null,
    residue: { todos: 0, debugLogging: 0, commentedOutCode: 0 },
    testTamper: { hits: 0, evidence: [] },
    ...extra,
  };
}

function makeTestResults(ok: boolean, passed?: number, failed?: number): TestResults {
  return {
    command: "npm test",
    ok,
    ...(passed !== undefined ? { passed } : {}),
    ...(failed !== undefined ? { failed } : {}),
  };
}

function pairwiseResult(
  variantA: string,
  variantB: string,
  winner: PairwiseWinner,
  extra: Partial<PairwiseResult> = {},
): PairwiseResult {
  const dim = (): PairwiseDimension => ({
    winner,
    evidenceA: "a.ts:1 — a",
    evidenceB: "b.ts:1 — b",
  });
  return {
    taskId: "t",
    executorModel: "sonnet",
    variantA,
    variantB,
    dimensions: { naming: dim(), structure: dim(), consistency: dim(), economy: dim() },
    overall: { winner, rationale: "why" },
    ...extra,
  };
}

function makeReport(extra: Partial<Report> = {}): Report {
  return {
    runId: "1e2f3a4b-5c6d-7e8f-9a0b-1c2d3e4f5a6b",
    generatedAt: "2026-07-14T00:00:00.000Z",
    taskId: "t",
    taskTitle: "Tasks",
    executorModels: ["sonnet"],
    judgeModel: "opus",
    results: [],
    ...extra,
  };
}

// Legacy fixtures (no judge/slop/testResults — the old pipeline's shape).
const aT1 = cell("alpha", "t1");
const aT2 = cell("alpha", "t2");
const bT1 = cell("bravo", "t1");
const bT2 = cell("bravo", "t2");
const multi = [bT2, aT1, bT1, aT2]; // deliberately unordered

const alphaSon = cell("alpha", "t", { executorModel: "sonnet" });
const alphaOpus = cell("alpha", "t", { executorModel: "opus" });
const crossModel = [alphaSon, alphaOpus];

test("formatScore keeps integers and renders means to one decimal", () => {
  assert.equal(formatScore(86), "86");
  assert.equal(formatScore(22.5), "22.5");
});

test("isScored: genuine judge-0 counts; failures/timeouts are excluded", () => {
  const judged0 = cell("z", "t");
  assert.equal(isScored(judged0), true);
  assert.equal(isScored(cell("z", "t", { executorFailure: "timed out" })), false);
  assert.equal(isScored(cell("z", "t", { judgeFailure: "bad json" })), false);
  assert.equal(excludedReasonOf(cell("z", "t", { executorFailure: "timeout" })), "timeout");
});

test("distinctModels returns models in first-seen order", () => {
  assert.deepEqual(distinctModels(crossModel), ["sonnet", "opus"]);
});

// --- Axis 1: Correctness -----------------------------------------------------

test("aggregateCorrectness separates tested cells from judge-fallback cells", () => {
  const rs = [
    cell("v", "t1", { testResults: makeTestResults(true, 5, 0) }),
    cell("v", "t2", { testResults: makeTestResults(false, 3, 2) }),
    cell("v", "t3", {
      judge: judgeResult({
        correctnessAssessment: { verdict: "likely_correct", evidence: ["wires the handler"] },
      }),
    }),
    cell("v", "t4", { judge: judgeResult() }), // null assessment → unknown
    cell("v", "t5", {}), // untested, judge missing → unknown (fail closed)
  ];
  const [agg] = aggregateCorrectness(rs);
  assert.equal(agg!.attemptedCount, 5);
  assert.equal(agg!.testedCount, 2);
  assert.equal(agg!.testedPassCount, 1);
  assert.deepEqual(agg!.fallback, { likelyCorrect: 1, likelyIncorrect: 0, unknown: 2 });
  assert.equal(agg!.legacy, false);
});

test("renderCorrectness keeps tested and fallback populations in separate columns", () => {
  const rs = [
    cell("v", "t1", { testResults: makeTestResults(true) }),
    cell("v", "t2", { testResults: makeTestResults(false) }),
    cell("v", "t3", {
      judge: judgeResult({
        correctnessAssessment: { verdict: "likely_incorrect", evidence: ["missing branch"] },
      }),
    }),
    cell("v", "t4", {}),
  ];
  const md = renderCorrectness(rs);
  assert.match(md, /\| v \| sonnet \| 1\/2 pass \| likely_correct: 0 · likely_incorrect: 1 · unknown: 1 \|/);
  assert.match(md, /never blended/);
  assert.doesNotMatch(md, /undefined|NaN/);
});

test("aggregateCorrectness excludes executor-failed cells from both populations (no double-count with Excluded cells)", () => {
  const rs = [
    cell("v", "t1", { testResults: makeTestResults(true) }),
    cell("v", "t2", { executorFailure: "Executor timed out and the container was killed." }),
  ];
  const [agg] = aggregateCorrectness(rs);
  assert.equal(agg!.attemptedCount, 2); // still counted as attempted
  assert.equal(agg!.testedCount, 1);
  assert.equal(agg!.testedPassCount, 1);
  // The failed cell must NOT land in the unknown tally — it lives under Excluded cells.
  assert.deepEqual(agg!.fallback, { likelyCorrect: 0, likelyIncorrect: 0, unknown: 0 });
  const md = renderCorrectness(rs);
  assert.match(md, /\| v \| sonnet \| 1\/1 pass \| — \|/);
});

test("renderCorrectness: legacy rows render em dashes; disqualified cells carry the ☠ marker", () => {
  const legacy = cell("old", "t1"); // neither testResults nor judge
  const dq = cell("dq", "t1", { testResults: makeTestResults(true), disqualified: true });
  const md = renderCorrectness([legacy, dq]);
  assert.match(md, /\| old \| sonnet \| — \| — \|/);
  assert.match(md, /\| dq ☠ DISQUALIFIED \| sonnet \| 1\/1 pass \| — \|/);
});

// --- Axis 2: Adherence — grade symbols + legacy fallback -----------------------

test("gradeSymbol maps every grade to its compact symbol", () => {
  assert.equal(gradeSymbol("held-by-abstraction"), "✓A");
  assert.equal(gradeSymbol("held-by-literal"), "✓L");
  assert.equal(gradeSymbol("held-by-inertia"), "~I");
  assert.equal(gradeSymbol("held-by-chain"), "~C");
  assert.equal(gradeSymbol("drift"), "✗");
  assert.equal(gradeSymbol("trap"), "⚠");
  assert.equal(gradeSymbol("unknown"), "?");
});

function anchored(
  variant: string,
  taskId: string,
  anchors: AnchorResult,
  extra: Partial<VariantTaskResult> = {},
): VariantTaskResult {
  return cell(variant, taskId, { anchors, ...extra });
}

// Legacy (grade-less) anchors: one bundle helped on one task, hurt on another.
const helpHeld = anchored("gstack", "memory-cents", {
  conventionHeld: true,
  turnsToGreen: 2,
  hitKnownTrap: false,
  evidence: "apply step emitted integer cents (subtotal * 100)",
});
const poisonTrap = anchored("gstack", "memory-cents-stale", {
  conventionHeld: false,
  hitKnownTrap: true,
  evidence: "reused stale integer-cents memory against migrated Decimal code",
});

test("hasMemoryEffect: true iff some result carries .anchors", () => {
  assert.equal(hasMemoryEffect([helpHeld, poisonTrap]), true);
  assert.equal(hasMemoryEffect(multi), false);
});

test("renderMemoryEffect: grade-less anchors render the EXACT legacy strings, no grade legend", () => {
  const brokeNoTrap = anchored("memoryless", "memory-cents", {
    conventionHeld: false,
    hitKnownTrap: false,
    evidence: "never adopted the convention",
  });
  const heldNoTurns = anchored("plain", "memory-cents", {
    conventionHeld: true,
    hitKnownTrap: false,
    evidence: "held without turn data",
  });
  const md = renderMemoryEffect([helpHeld, poisonTrap, brokeNoTrap, heldNoTurns]);
  // Byte-exact legacy pivot cells — the integration tests depend on these.
  assert.match(md, /\| gstack \| ✓ held \(2 turns\) \| ✗ hit trap \|/);
  assert.match(md, /\| memoryless \| ✗ broke \| — \|/);
  assert.match(md, /\| plain \| ✓ held \| — \|/);
  assert.doesNotMatch(md, /Grades:/); // legend only when graded verdicts exist
  // Per-task detail keeps its shape (no score column — the anchor is never scored).
  assert.match(md, /Convention held \| Turns to green \| Hit known trap \| Evidence/);
  assert.match(md, /apply step emitted integer cents/);
  assert.doesNotMatch(md, /undefined|NaN/);
});

test("renderMemoryEffect renders grade symbols + legend when grades are present", () => {
  const abstraction = anchored("os", "reg", {
    conventionHeld: true, turnsToGreen: 2, hitKnownTrap: false, evidence: "e",
    grade: "held-by-abstraction",
  });
  const inertia = anchored("os", "gotcha", {
    conventionHeld: true, hitKnownTrap: false, evidence: "e", grade: "held-by-inertia",
  });
  const trap = anchored("naked", "reg", {
    conventionHeld: false, hitKnownTrap: true, evidence: "e", grade: "trap",
  });
  const unknown = anchored("naked", "gotcha", {
    conventionHeld: false, hitKnownTrap: false, evidence: "e", grade: "unknown",
  });
  const md = renderMemoryEffect([abstraction, inertia, trap, unknown]);
  assert.match(md, /\| os \| ✓A \(2 turns\) \| ~I \|/);
  assert.match(md, /\| naked \| ⚠ \| \? \|/);
  assert.match(md, /Grades: ✓A = held-by-abstraction · ✓L = held-by-literal · ~I = held-by-inertia/);
  // Detail "Convention held" column shows the grade symbol too.
  assert.match(md, /\| os \| ✓A \| 2 \| no \|/);
});

test("held-by-chain renders ~C with its legend entry in strength order", () => {
  const chain = anchored("os", "reg", {
    conventionHeld: true, hitKnownTrap: false,
    evidence: "cumulative-only hold; no link-level evidence", grade: "held-by-chain",
  });
  const md = renderMemoryEffect([chain]);
  assert.match(md, /\| os \| ~C \|/); // pivot cell
  assert.match(md, /\| os \| ~C \| — \| no \|/); // detail row
  // Legend ordering: ✓A > ✓L > ~I > ~C > ✗ > ⚠ > ?
  assert.match(md, /~I = held-by-inertia · ~C = held-by-chain · ✗ = drift · ⚠ = trap · \? = unknown/);
});

test("renderMemoryEffect: undefined turnsToGreen renders as — without throwing", () => {
  const noTurns = anchored("gstack", "memory-cents", {
    conventionHeld: false,
    hitKnownTrap: false,
    evidence: "never reached the convention",
  });
  const md = renderMemoryEffect([noTurns]);
  assert.match(md, /### Task: `memory-cents`/);
  assert.match(md, /\| gstack \| ✗ \| — \| no \|/);
  assert.doesNotMatch(md, /undefined|NaN/);
});

test("renderReportMarkdown surfaces MEMORY EFFECT for sequence runs and buildReportJson structures it", () => {
  const report = makeReport({
    taskId: "memory-cents,memory-cents-stale",
    taskTitle: "Sequential memory",
    results: [helpHeld, poisonTrap],
  });
  const md = renderReportMarkdown(report);
  assert.match(md, /## Memory effect \(not scored\)/);
  // Adherence sits between Correctness and Craft in the lexicographic order.
  assert.ok(md.indexOf("## Correctness") < md.indexOf("## Memory effect"));
  assert.ok(md.indexOf("## Memory effect") < md.indexOf("## Craft"));

  const json = buildReportJson(report) as {
    memoryEffect: {
      tasks: string[];
      cells: Array<{
        taskId: string;
        conventionHeld: boolean;
        turnsToGreen: number | null;
        hitKnownTrap: boolean;
        scored: boolean;
      }>;
    };
  };
  assert.deepEqual(json.memoryEffect.tasks, ["memory-cents", "memory-cents-stale"]);
  const help = json.memoryEffect.cells.find((c) => c.taskId === "memory-cents")!;
  assert.equal(help.conventionHeld, true);
  assert.equal(help.turnsToGreen, 2);
  assert.equal(help.hitKnownTrap, false);
  assert.equal(help.scored, true);
  const poison = json.memoryEffect.cells.find((c) => c.taskId === "memory-cents-stale")!;
  assert.equal(poison.conventionHeld, false);
  assert.equal(poison.turnsToGreen, null);
  assert.equal(poison.hitKnownTrap, true);
});

test("single-shot report: NO Memory effect section, json has no memoryEffect key", () => {
  const report = makeReport({ taskId: "t1,t2", results: multi });
  const md = renderReportMarkdown(report);
  assert.doesNotMatch(md, /Memory effect/);
  assert.equal(buildMemoryEffect(multi), undefined);
  const json = buildReportJson(report) as Record<string, unknown>;
  assert.ok(!("memoryEffect" in json));
});

// --- Axis 2: Adherence — campaign trajectory ----------------------------------

const CAMPAIGN_IDS = [
  "t1-search",
  "t2-rename",
  "t3-created-at",
  "t4-attachments",
  "t5-revisions",
];

function ruleAnchor(held: boolean, trap = false): AnchorResult {
  return {
    conventionHeld: held,
    hitKnownTrap: trap,
    evidence: held ? "diff used epoch-seconds and newId(" : "diff used toISOString / randomUUID",
  };
}

function campaignTaskResult(
  index: number,
  taskId: string,
  extra: Partial<CampaignTaskResult> = {},
): CampaignTaskResult {
  return {
    taskId,
    index,
    metrics: { wallMs: 10_000, numTurns: 3 },
    ...extra,
  };
}

/** Build a 5-link campaign; `anchored` covers links index 2/3/4 (true|false|"trap"). */
function campaign(variant: string, anchored: (boolean | "trap")[]): CampaignResult {
  const tasks = CAMPAIGN_IDS.map((taskId, index) => {
    if (index < 2) return campaignTaskResult(index, taskId); // links 0/1 have no anchor
    const v = anchored[index - 2]!;
    return campaignTaskResult(index, taskId, {
      anchors: ruleAnchor(v === true, v === "trap"),
    });
  });
  return { variant, executorModel: "sonnet", campaignId: "campaign-conventions", tasks };
}

const agenticOs = campaign("agentic-os", [true, true, true]);
const nakedCamp = campaign("naked", ["trap", "trap", "trap"]);
const gstackCamp = campaign("gstack", [true, false, "trap"]);
const campaigns = [agenticOs, nakedCamp, gstackCamp];

test("renderCampaignMemoryEffect leads with the cumulative adherence delta + legacy trajectory strings", () => {
  const md = renderCampaignMemoryEffect(campaigns);
  assert.match(md, /\*\*Cumulative adherence:\*\* agentic-os 3\/3 adhered \| naked 0\/3 \| gstack 1\/3/);
  assert.match(md, /\| Task \| agentic-os \| naked \| gstack \|/);
  // Byte-exact legacy cells (grade-less anchors) — integration tests depend on these.
  assert.match(md, /#2 `t3-created-at` \| ✓ held · 3t \| ✗ drift ⚠ trap · 3t \| ✓ held · 3t \|/);
  assert.match(md, /#0 `t1-search` \| — · 3t \|/);
  assert.doesNotMatch(md, /Grades:/); // legend only when graded verdicts exist
  assert.doesNotMatch(md, /undefined|NaN/);
});

test("campaign trajectory cells show grade symbols + legend when graded", () => {
  const graded: CampaignResult = {
    variant: "os",
    executorModel: "sonnet",
    campaignId: "c",
    tasks: [
      campaignTaskResult(0, "l0", {
        anchors: { conventionHeld: true, hitKnownTrap: false, evidence: "e", grade: "held-by-literal" },
      }),
      campaignTaskResult(1, "l1", {
        anchors: { conventionHeld: false, hitKnownTrap: true, evidence: "e", grade: "trap" },
      }),
      campaignTaskResult(2, "l2", {
        anchors: { conventionHeld: true, hitKnownTrap: false, evidence: "e", grade: "held-by-inertia" },
      }),
    ],
  };
  const md = renderCampaignMemoryEffect([graded]);
  assert.match(md, /#0 `l0` \| ✓L · 3t \|/);
  assert.match(md, /#1 `l1` \| ⚠ · 3t \|/);
  assert.match(md, /#2 `l2` \| ~I · 3t \|/);
  assert.match(md, /Grades: ✓A = held-by-abstraction/);
});

test("renderReportMarkdown surfaces the campaign memory effect; buildReportJson structures it", () => {
  const report = makeReport({
    taskId: "campaign-conventions",
    taskTitle: "Campaign",
    results: multi,
    campaigns,
  });
  const md = renderReportMarkdown(report);
  assert.match(md, /## Memory effect \(campaign, not scored\)/);
  assert.match(md, /agentic-os 3\/3 adhered \| naked 0\/3 \| gstack 1\/3/);

  const json = buildReportJson(report) as {
    memoryEffectCampaign: {
      bundles: Array<{
        variant: string;
        adheredCount: number;
        anchoredCount: number;
        tasks: Array<{
          index: number;
          conventionHeld: boolean | null;
          hitKnownTrap: boolean;
          turns: number | null;
        }>;
      }>;
    };
  };
  const os = json.memoryEffectCampaign.bundles.find((b) => b.variant === "agentic-os")!;
  assert.equal(os.adheredCount, 3);
  assert.equal(os.anchoredCount, 3);
  const nk = json.memoryEffectCampaign.bundles.find((b) => b.variant === "naked")!;
  assert.equal(nk.adheredCount, 0);
  assert.equal(nk.anchoredCount, 3);
  const link0 = os.tasks.find((t) => t.index === 0)!;
  assert.equal(link0.conventionHeld, null);
  assert.equal(link0.hitKnownTrap, false);
  assert.equal(link0.turns, 3);
});

test("report WITHOUT campaigns: no campaign section, json has no memoryEffectCampaign key", () => {
  const report = makeReport({ taskId: "t1,t2", results: multi });
  const md = renderReportMarkdown(report);
  assert.doesNotMatch(md, /Memory effect \(campaign/);
  const json = buildReportJson(report) as Record<string, unknown>;
  assert.ok(!("memoryEffectCampaign" in json));
});

test("campaign trajectory: a failure is marked ✗fail; a held anchor survives a judge failure", () => {
  const broke = campaign("broke", [true, false, "trap"]);
  // Executor-failed link: no anchor was computed → adherence —, ✗fail marker.
  broke.tasks[4] = {
    taskId: "t5-revisions",
    index: 4,
    metrics: { wallMs: 5000 },
    failure: "executor timed out",
  };
  // Judge-failed-but-executorOk link: the deterministic anchor still stands.
  broke.tasks[2] = {
    taskId: "t3-created-at",
    index: 2,
    metrics: { wallMs: 3000, numTurns: 4 },
    anchors: { conventionHeld: true, hitKnownTrap: false, evidence: "held" },
    failure: "judge returned malformed output",
  };
  const md = renderCampaignMemoryEffect([broke]);
  assert.match(md, /#4 `t5-revisions` \| — · ✗fail · — \|/);
  assert.match(md, /#2 `t3-created-at` \| ✓ held · ✗fail · 4t \|/);
  assert.match(md, /#0 `t1-search` \| —/);
  assert.doesNotMatch(md, /undefined|NaN/);

  const json = buildCampaignMemoryEffect([broke])!;
  const failLink = json.bundles[0]!.tasks.find((t) => t.index === 4)!;
  assert.equal(failLink.turns, null);
  assert.equal(failLink.conventionHeld, null);
  assert.equal(failLink.failure, "executor timed out");
});

// --- Campaign links fold into the per-cell axes --------------------------------

/** A campaign whose links carry five-axis fields (judge/slop/tests/surface/dq). */
function fiveAxisCampaign(
  variant: string,
  links: Array<Partial<CampaignTaskResult>>,
  campaignId = "camp",
): CampaignResult {
  return {
    variant,
    executorModel: "sonnet",
    campaignId,
    tasks: links.map((extra, index) => campaignTaskResult(index, `l${index}`, extra)),
  };
}

test("campaign links fold into judge-craft medians; disqualified and failed links excluded", () => {
  const single = cell("v", "t1", { judge: judgeResult({ craft: craftScores({ naming: 2 }) }) });
  const camp = fiveAxisCampaign("v", [
    { judge: judgeResult({ craft: craftScores({ naming: 4 }) }) },
    { judge: judgeResult({ craft: craftScores({ naming: 0 }) }), disqualified: true },
    { judge: judgeResult({ craft: craftScores({ naming: 0 }) }), failure: "executor timed out" },
  ]);
  const md = renderJudgeCraft([single], [camp]);
  // Contributing: single cell (naming 2) + link 0 (naming 4) → lower median 2 over 2 cells.
  assert.match(md, /\| v \| sonnet \| 2 \| 3 \| 3 \| 3 \| 0 \| 2 \|/);
  assert.doesNotMatch(md, /No judge craft verdicts/);
});

test("campaign links fold into slop means; link churn reaches the table", () => {
  const single = cell("v", "t1", { slop: slopMetrics({ duplicationDelta: 1 }) });
  const camp = fiveAxisCampaign("v", [
    { slop: slopMetrics({ duplicationDelta: 3, churnRatio: 0.5 }) },
    { slop: slopMetrics({ duplicationDelta: 100 }), disqualified: true },
    { slop: slopMetrics({ duplicationDelta: 50 }), failure: "boom" },
  ]);
  const md = renderSlop([single], [camp]);
  // mean dup over {1, 3} = 2; churn mean over the one non-null link = 0.50.
  assert.match(md, /\| v \| sonnet \| 2 \| 0\.50 \| 0 \| 0 \| 0 \| 0 \|/);
});

test("campaign links fold into correctness tallies; failed links are excluded", () => {
  const single = cell("v", "t1", { testResults: makeTestResults(true) });
  const camp = fiveAxisCampaign("v", [
    { testResults: makeTestResults(false) },
    {
      judge: judgeResult({
        correctnessAssessment: { verdict: "likely_correct", evidence: ["wires the handler"] },
      }),
    },
    { failure: "executor timed out" },
  ]);
  const md = renderCorrectness([single], [camp]);
  assert.match(
    md,
    /\| v \| sonnet \| 1\/2 pass \| likely_correct: 1 · likely_incorrect: 0 · unknown: 0 \|/,
  );
});

test("blast radius includes campaign links under the campaignId[index:taskId] identity; adversarial links get ☠", () => {
  const camp = fiveAxisCampaign(
    "os",
    [
      {
        filesOutsideExpectedSurface: ["src/stray.ts"],
        judge: judgeResult({
          blastRadius: [
            { file: "src/stray.ts", classification: "overreach", evidence: "unrequested refactor" },
          ],
        }),
      },
      {
        filesOutsideExpectedSurface: ["test/fixtures.ts"],
        disqualified: true,
        judge: judgeResult({
          blastRadius: [
            { file: "test/fixtures.ts", classification: "adversarial", evidence: "loosened assertions" },
          ],
        }),
      },
    ],
    "camp-conventions",
  );
  const md = renderBlastRadius([], [camp]);
  assert.match(
    md,
    /\| `camp-conventions\[0:l0\] \(os × sonnet\)` \| `src\/stray\.ts` \| overreach \| unrequested refactor \|/,
  );
  assert.match(
    md,
    /\| \*\*`camp-conventions\[1:l1\] \(os × sonnet\)`\*\* \| \*\*`test\/fixtures\.ts`\*\* \| \*\*☠ DISQUALIFIED — adversarial\*\* \| \*\*loosened assertions\*\* \|/,
  );
});

test("campaign trajectory appends ☠ to a disqualified link's adherence symbol", () => {
  const heldAnchor: AnchorResult = {
    conventionHeld: true, hitKnownTrap: false, evidence: "e", grade: "held-by-literal",
  };
  const camp = fiveAxisCampaign("os", [
    { anchors: heldAnchor, disqualified: true },
    { anchors: heldAnchor },
  ]);
  const md = renderCampaignMemoryEffect([camp]);
  assert.match(md, /#0 `l0` \| ✓L ☠ · 3t \|/);
  assert.match(md, /#1 `l1` \| ✓L · 3t \|/); // non-disqualified stays byte-identical
  assert.match(md, /☠ = disqualified \(adversarial\)/);
});

test("renderReportMarkdown: an adversarial-disqualified campaign link is visible outside report.json", () => {
  const camp = fiveAxisCampaign("os", [
    {
      judge: judgeResult(),
      slop: slopMetrics(),
      testResults: makeTestResults(true),
      filesOutsideExpectedSurface: [],
    },
    {
      judge: judgeResult({
        blastRadius: [
          { file: "test/x.ts", classification: "adversarial", evidence: "edited tests to pass" },
        ],
      }),
      filesOutsideExpectedSurface: ["test/x.ts"],
      disqualified: true,
      anchors: { conventionHeld: true, hitKnownTrap: false, evidence: "e", grade: "held-by-literal" },
    },
  ]);
  const md = renderReportMarkdown(makeReport({ results: [], campaigns: [camp] }));
  // Blast radius: the link row is bold with the disqualification marker.
  const blast = md.slice(md.indexOf("## Blast radius"));
  assert.match(
    blast,
    /\*\*`camp\[1:l1\] \(os × sonnet\)`\*\* \| \*\*`test\/x\.ts`\*\* \| \*\*☠ DISQUALIFIED — adversarial\*\*/,
  );
  // Correctness: the campaign's (variant × model) row carries the ☠ marker.
  assert.match(md, /\| os ☠ DISQUALIFIED \| sonnet \| 1\/1 pass \|/);
  // Trajectory: the disqualified link's cell carries ☠ on its grade symbol.
  assert.match(md, /#1 `l1` \| ✓L ☠ · 3t \|/);
  // Craft renders link data instead of collapsing to the legacy one-liner.
  assert.doesNotMatch(md, /No craft data/);
});

// --- Axis 3: Craft — judge medians ---------------------------------------------

test("aggregateCraft: lower median — odd count, even count, unknowns excluded-but-counted, all-unknown", () => {
  const odd = [
    cell("m", "t1", { judge: judgeResult({ craft: craftScores({ naming: 1 }) }) }),
    cell("m", "t2", { judge: judgeResult({ craft: craftScores({ naming: 3 }) }) }),
    cell("m", "t3", { judge: judgeResult({ craft: craftScores({ naming: 4 }) }) }),
  ];
  assert.equal(aggregateCraft(odd)[0]!.median.naming, 3);

  const even = [
    cell("m", "t1", { judge: judgeResult({ craft: craftScores({ naming: 2 }) }) }),
    cell("m", "t2", { judge: judgeResult({ craft: craftScores({ naming: 3 }) }) }),
  ];
  assert.equal(aggregateCraft(even)[0]!.median.naming, 2); // LOWER median, never 2.5

  const withUnknown = [
    cell("m", "t1", { judge: judgeResult({ craft: craftScores({ naming: 2 }) }) }),
    cell("m", "t2", { judge: judgeResult({ craft: craftScores({ naming: "unknown" }) }) }),
    cell("m", "t3", { judge: judgeResult({ craft: craftScores({ naming: 4 }) }) }),
  ];
  const agg = aggregateCraft(withUnknown)[0]!;
  assert.equal(agg.median.naming, 2); // lower median of [2, 4]
  assert.equal(agg.unknownCount, 1);

  const allUnknown = [
    cell("m", "t1", {
      judge: judgeResult({
        craft: craftScores({
          naming: "unknown", structure: "unknown", consistency: "unknown", economy: "unknown",
        }),
      }),
    }),
  ];
  const agg2 = aggregateCraft(allUnknown)[0]!;
  assert.equal(agg2.median.naming, null);
  assert.equal(agg2.unknownCount, 4);
});

test("renderJudgeCraft renders — for all-unknown dimensions and reports the unknown count", () => {
  const md = renderJudgeCraft([
    cell("m", "t1", {
      judge: judgeResult({
        craft: craftScores({
          naming: "unknown", structure: "unknown", consistency: "unknown", economy: "unknown",
        }),
      }),
    }),
  ]);
  assert.match(md, /\| m \| sonnet \| — \| — \| — \| — \| 4 \| 1 \|/);
  assert.doesNotMatch(md, /undefined|NaN/);
});

test("disqualified cells are excluded from craft aggregation but stay in correctness with the marker", () => {
  const good = cell("v", "t1", {
    judge: judgeResult({ craft: craftScores({ naming: 4 }) }),
    testResults: makeTestResults(true),
  });
  const dq = cell("v", "t2", {
    judge: judgeResult({ craft: craftScores({ naming: 0 }) }),
    testResults: makeTestResults(true),
    disqualified: true,
  });
  const agg = aggregateCraft([good, dq])[0]!;
  assert.equal(agg.cellCount, 1);
  assert.equal(agg.median.naming, 4); // the disqualified 0 never enters
  const correctness = renderCorrectness([good, dq]);
  assert.match(correctness, /v ☠ DISQUALIFIED/);
  assert.match(correctness, /2\/2 pass/); // still visible in correctness
});

// --- Axis 3: Craft — deterministic slop ----------------------------------------

test("aggregateSlop: churn mean over non-null cells, summed residue/tamper, disqualified excluded", () => {
  const s1 = cell("v", "t1", {
    slop: slopMetrics({
      duplicationDelta: 2,
      churnRatio: null,
      residue: { todos: 1, debugLogging: 0, commentedOutCode: 2 },
    }),
  });
  const s2 = cell("v", "t2", {
    slop: slopMetrics({
      duplicationDelta: 3,
      churnRatio: 0.5,
      residue: { todos: 2, debugLogging: 1, commentedOutCode: 0 },
      testTamper: { hits: 2, evidence: ["test/x.ts:3 — it.skip"] },
    }),
  });
  const dq = cell("v", "t3", {
    slop: slopMetrics({ duplicationDelta: 100, churnRatio: 1, testTamper: { hits: 9, evidence: [] } }),
    disqualified: true,
  });
  const [agg] = aggregateSlop([s1, s2, dq]);
  assert.equal(agg!.cellCount, 2);
  assert.equal(agg!.meanDuplicationDelta, 2.5);
  assert.equal(agg!.meanChurnRatio, 0.5); // null-churn cell excluded from the mean
  assert.deepEqual(agg!.residue, { todos: 3, debugLogging: 1, commentedOutCode: 2 });
  assert.equal(agg!.testTamperHits, 2);

  const md = renderSlop([s1, s2, dq]);
  assert.match(md, /\| v \| sonnet \| 2\.5 \| 0\.50 \| 3 \| 1 \| 2 \| 2 \|/);
});

test("renderSlop renders — churn when every cell's churn is null (single-shot cells)", () => {
  const md = renderSlop([cell("v", "t1", { slop: slopMetrics({ duplicationDelta: 1 }) })]);
  assert.match(md, /\| v \| sonnet \| 1 \| — \| 0 \| 0 \| 0 \| 0 \|/);
  assert.doesNotMatch(md, /undefined|NaN/);
});

// --- Axis 3: Craft — pairwise ---------------------------------------------------

test("aggregatePairwise resolves winners through variantA/variantB, not the letter", () => {
  // The judge said "A" — and the A slot held bravo after shuffling. bravo wins.
  const agg = aggregatePairwise([pairwiseResult("bravo", "alpha", "A")]);
  const bravo = agg.variants.find((v) => v.variant === "bravo")!;
  const alpha = agg.variants.find((v) => v.variant === "alpha")!;
  assert.equal(bravo.wins, 1);
  assert.equal(bravo.losses, 0);
  assert.equal(alpha.losses, 1);
  assert.deepEqual(agg.pairs, [
    { variantX: "bravo", variantY: "alpha", winsX: 1, winsY: 0, ties: 0 },
  ]);
});

test("aggregatePairwise: shuffled orientations fold into one pair; ties excluded from win rate; bias audited", () => {
  const comparisons = [
    pairwiseResult("alpha", "bravo", "A"), // alpha wins (an A-slot win)
    pairwiseResult("bravo", "alpha", "A"), // bravo wins (an A-slot win)
    pairwiseResult("alpha", "bravo", "tie"),
    pairwiseResult("alpha", "bravo", "B", { judgeFailure: "bad json" }), // unusable
  ];
  const agg = aggregatePairwise(comparisons);
  assert.equal(agg.comparisons, 3); // the judge-failed comparison is dropped
  assert.deepEqual(agg.pairs, [
    { variantX: "alpha", variantY: "bravo", winsX: 1, winsY: 1, ties: 1 },
  ]);
  const alpha = agg.variants.find((v) => v.variant === "alpha")!;
  assert.equal(alpha.winRate, 0.5); // 1/(1+1) — the tie never enters
  assert.deepEqual(agg.positionBias, { aSlotWins: 2, decisive: 2 });

  const md = renderPairwise(comparisons);
  assert.match(md, /- alpha vs bravo: 1–1 \(1 ties\)/);
  assert.match(md, /\| alpha \| 50% \| 1–1–1 \|/);
  assert.match(md, /A-slot won 2 of 2 decisive comparisons \(expected ≈50%\)/);
});

test("renderPairwise: ties-only variant renders — win rate; absent pairwise is a one-liner", () => {
  const md = renderPairwise([pairwiseResult("a1", "b1", "tie")]);
  assert.match(md, /\| a1 \| — \| 0–0–1 \|/);
  assert.match(md, /A-slot won 0 of 0 decisive comparisons/);
  assert.match(renderPairwise(undefined), /No pairwise comparisons ran/);
  assert.match(renderPairwise([]), /No pairwise comparisons ran/);
});

test("renderCraft collapses to a one-liner for legacy results; renders all three subsections otherwise", () => {
  assert.match(renderCraft(multi), /No craft data/);
  const md = renderCraft([cell("v", "t", { slop: slopMetrics() })]);
  assert.match(md, /### Slop \(deterministic\)/);
  assert.match(md, /### Judge craft \(medians\)/);
  assert.match(md, /### Pairwise \(cross-bundle\)/);
});

// --- Axis 4: Efficiency (run metrics) -------------------------------------------

test("aggregateMetrics sums cost/tokens/time across a variant's tasks", () => {
  const aggs = aggregateMetrics(multi);
  const alpha = aggs.find((m) => m.variant === "alpha")!;
  assert.equal(alpha.wallMs, 20_000);
  assert.equal(alpha.execCostUsd, 0.1);
  assert.equal(alpha.inputTokens, 2000);
  assert.equal(alpha.outputTokens, 400);
  assert.equal(alpha.numTurns, 6);
  assert.equal(alpha.judgeCostUsd, 0.04);
});

test("renderRunMetrics renders a missing-cost run as em dash", () => {
  const withCost = cell("hascost", "t");
  const noCost = cell("nocost", "t", { metrics: { executor: { wallMs: 8000 } } });
  const md = renderRunMetrics([withCost, noCost]);
  assert.match(md, /never a score component/);
  assert.match(md, /\| Variant \| Model \| Exec time/);
  assert.match(md, /\| hascost \| sonnet \| 10.0s \| \$0.0500 \|/);
  assert.match(md, /\| nocost \| sonnet \| 8.0s \| — \| — \| — \| — \| — \|/);
  assert.doesNotMatch(md, /undefined|NaN/);
});

test("renderRunMetrics marks disqualified units with ☠ in the Efficiency table", () => {
  const md = renderRunMetrics([cell("dq", "t", { disqualified: true })]);
  assert.match(md, /\| dq ☠ DISQUALIFIED \| sonnet \|/);
});

// --- Axis 5: Reliability ---------------------------------------------------------

test("aggregateReliability: stddev + craft ranges + anchor agreement on a 3-repeat group", () => {
  const rep = (repeat: number, costUsd: number, wallMs: number, naming: CraftScoreValue) =>
    cell("v", "t", {
      repeat,
      metrics: { executor: { wallMs, costUsd } },
      judge: judgeResult({
        craft: craftScores({ naming, economy: repeat === 1 ? "unknown" : 3 }),
      }),
      anchors: { conventionHeld: true, hitKnownTrap: false, evidence: "e", grade: "held-by-literal" },
    });
  const rs = [rep(1, 0.04, 10_000, 2), rep(2, 0.05, 12_000, 4), rep(3, 0.06, 14_000, 3)];

  const [g] = aggregateReliability(rs);
  assert.equal(g!.runCount, 3);
  assert.ok(Math.abs(g!.costStddevUsd! - 0.0081649) < 0.0001); // population σ
  assert.ok(Math.abs(g!.wallMsStddev - 1632.99) < 0.5);
  assert.deepEqual(g!.craftRange.naming, { min: 2, max: 4 });
  assert.deepEqual(g!.craftRange.structure, { min: 3, max: 3 });
  assert.equal(g!.craftUnknowns, 1);
  assert.deepEqual(g!.anchorGrades, ["held-by-literal", "held-by-literal", "held-by-literal"]);

  const md = renderReliability(rs);
  assert.match(md, /\| `t` × v \[sonnet\] \| 3 \| \$0\.0082 \| 1\.6s \| 2–4 \| 3 \| 3 \| 3 \| 1 \| 3\/3 identical \|/);
  assert.doesNotMatch(md, /undefined|NaN/);
});

test("renderReliability lists distinct anchor grades and degrades missing costs to —", () => {
  const r1 = cell("v", "t", {
    repeat: 1,
    metrics: { executor: { wallMs: 10_000 } }, // no cost reported
    anchors: { conventionHeld: true, hitKnownTrap: false, evidence: "e", grade: "held-by-literal" },
  });
  const r2 = cell("v", "t", {
    repeat: 2,
    metrics: { executor: { wallMs: 10_000, costUsd: 0.05 } }, // only one cost → σ undefined
    anchors: { conventionHeld: false, hitKnownTrap: true, evidence: "e" }, // grade-less → legacy label
  });
  const [g] = aggregateReliability([r1, r2]);
  assert.equal(g!.costStddevUsd, null);
  assert.deepEqual(g!.anchorGrades, ["held-by-literal", "trap"]);
  const md = renderReliability([r1, r2]);
  assert.match(md, /\| `t` × v \[sonnet\] \| 2 \| — \|/);
  assert.match(md, /held-by-literal, trap/);
});

test("aggregateReliability excludes executor-failed repeats — their wallMs=0 never inflates σ", () => {
  const ok1 = cell("v", "t", {
    repeat: 1,
    metrics: { executor: { wallMs: 10_000, costUsd: 0.04 } },
    judge: judgeResult({ craft: craftScores({ naming: 2 }) }),
  });
  const ok2 = cell("v", "t", {
    repeat: 2,
    metrics: { executor: { wallMs: 14_000, costUsd: 0.06 } },
    judge: judgeResult({ craft: craftScores({ naming: 4 }) }),
  });
  const execFailed = cell("v", "t", {
    repeat: 3,
    metrics: { executor: { wallMs: 0 } },
    executorFailure: "Executor timed out and the container was killed.",
  });
  const [g] = aggregateReliability([ok1, ok2, execFailed]);
  assert.equal(g!.runCount, 2); // the executor-failed repeat is gone entirely
  assert.equal(g!.wallMsStddev, 2000); // σ of [10000, 14000] — the 0 never entered
  assert.deepEqual(g!.craftRange.naming, { min: 2, max: 4 });
  assert.equal(g!.judgeFailures, 0);

  // A 2-repeat group reduced to 1 by an executor failure says nothing about spread.
  assert.deepEqual(aggregateReliability([ok1, execFailed]), []);
});

test("aggregateReliability counts judge-failed repeats as judgeFailures, never as craft unknowns", () => {
  const heldAnchor: AnchorResult = {
    conventionHeld: true, hitKnownTrap: false, evidence: "e", grade: "held-by-literal",
  };
  const ok = cell("v", "t", { repeat: 1, judge: judgeResult(), anchors: heldAnchor });
  const judgeFailed = cell("v", "t", {
    repeat: 2,
    judgeFailure: "judge returned malformed output",
    judge: judgeResult({
      craft: craftScores({
        naming: "unknown", structure: "unknown", consistency: "unknown", economy: "unknown",
      }),
    }),
    anchors: heldAnchor,
  });
  const [g] = aggregateReliability([ok, judgeFailed]);
  assert.equal(g!.runCount, 2); // still counts for cost/time spread — the executor ran
  assert.equal(g!.craftUnknowns, 0); // NOT +4 from the judge-failed repeat
  assert.equal(g!.judgeFailures, 1);
  assert.deepEqual(g!.craftRange.naming, { min: 3, max: 3 }); // judge-OK repeat only
  // The deterministic anchor survives a judge failure and still counts.
  assert.deepEqual(g!.anchorGrades, ["held-by-literal", "held-by-literal"]);

  const md = renderReliability([ok, judgeFailed]);
  assert.match(md, /\| 0 \(judgeFailures: 1\) \|/);
});

test("renderReliability: single-run reports say so; repeat-less results never group", () => {
  assert.deepEqual(aggregateReliability(multi), []);
  assert.match(renderReliability(multi), /single run per cell — no reliability data \(use --repeats N\)/);
});

// --- Blast radius ----------------------------------------------------------------

test("renderBlastRadius: judge classifications, unclassified fallback, and ☠ adversarial rows", () => {
  const overreach = cell("v", "t1", {
    filesOutsideExpectedSurface: ["src/extra.ts", "docs/notes.md"],
    judge: judgeResult({
      blastRadius: [
        { file: "src/extra.ts", classification: "overreach", evidence: "unrequested refactor" },
      ],
    }),
  });
  const adversarial = cell("w", "t1", {
    filesOutsideExpectedSurface: ["test/fixtures.ts"],
    disqualified: true,
    judge: judgeResult({
      blastRadius: [
        { file: "test/fixtures.ts", classification: "adversarial", evidence: "loosened assertions" },
      ],
    }),
  });
  const md = renderBlastRadius([overreach, adversarial]);
  assert.match(md, /\| `t1__v__sonnet` \| `src\/extra\.ts` \| overreach \| unrequested refactor \|/);
  // Out-of-scope file the judge never classified → unclassified, never dropped.
  assert.match(md, /\| `t1__v__sonnet` \| `docs\/notes\.md` \| unclassified \| — \|/);
  // Adversarial row is bolded with the disqualification marker.
  assert.match(md, /\| \*\*`t1__w__sonnet`\*\* \| \*\*`test\/fixtures\.ts`\*\* \| \*\*☠ DISQUALIFIED — adversarial\*\* \| \*\*loosened assertions\*\* \|/);
});

test("cellText strips control chars, DEL, zero-width chars; neutralizes ANSI; escapes pipes", () => {
  const dirty =
    "evil\u0007 \u001B[31mred\u001B[0m zero\u200Bwidth\u007F\uFEFF | pipe\nline";
  assert.equal(cellText(dirty), "evil [31mred[0m zerowidth \\| pipe line");
});

test("judge-authored blast-radius evidence passes through the cellText choke point", () => {
  const md = renderBlastRadius([
    cell("v", "t", {
      filesOutsideExpectedSurface: ["a.ts"],
      judge: judgeResult({
        blastRadius: [
          { file: "a.ts", classification: "overreach", evidence: "sneaky\u001B[31m\u200B evidence" },
        ],
      }),
    }),
  ]);
  assert.match(md, /sneaky\[31m evidence/);
  assert.doesNotMatch(md, /[\u001B\u200B]/);
});

test("renderBlastRadius one-liners: no surface declared vs everything in scope", () => {
  assert.match(renderBlastRadius(multi), /No cell declared an expected surface/);
  assert.match(
    renderBlastRadius([cell("v", "t", { filesOutsideExpectedSurface: [] })]),
    /stayed within/,
  );
});

// --- Behavioral signals -----------------------------------------------------

function behavior(extra: Partial<Behavior> = {}): Behavior {
  return {
    subAgents: {
      count: 3,
      byType: { engineer: 2, "code-reviewer": 1 },
      dispatches: [{ type: "engineer" }, { type: "engineer" }, { type: "code-reviewer" }],
    },
    toolCalls: { total: 12, byName: { Agent: 3, Bash: 5, Read: 4 } },
    changedFileShape: { source: 2, test: 1, docs: 0, linesAdded: 120, linesRemoved: 8 },
    touchedFiles: ["src/a.ts", "src/b.ts", "src/a.test.ts"],
    diffHash: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    testCasesAdded: 4,
    ...extra,
  };
}

test("renderBehaviorComparison groups by task; with-behavior shows counts, without shows —", () => {
  const withB = cell("alpha", "t1", { behavior: behavior() });
  const withoutB = cell("bravo", "t1", {});
  const otherTask = cell("alpha", "t2", {
    behavior: behavior({ subAgents: { count: 0, byType: {}, dispatches: [] } }),
  });

  const md = renderBehaviorComparison([withB, withoutB, otherTask]);
  assert.match(md, /### Task: `t1`/);
  assert.match(md, /### Task: `t2`/);
  assert.match(md, /\| alpha \| 3 \(engineer, code-reviewer\) \| 12 \| 2\/1\/0 \| \+120\/-8 \| 4 \| `abcdef01` \|/);
  assert.match(md, /\| bravo \| — \| — \| — \| — \| — \| — \|/);
  const t2Block = md.slice(md.indexOf("### Task: `t2`"));
  assert.match(t2Block, /\| alpha \| 0 \| 12 \|/);
  assert.doesNotMatch(md, /undefined|NaN/);
});

// --- Excluded cells ----------------------------------------------------------

test("renderExcludedCells: lists each excluded (variant, model, task) with reason", () => {
  const good = cell("good", "t1");
  const timedOut = cell("good", "t2", {
    executorFailure: "Executor timed out and the container was killed.",
  });
  assert.match(
    renderExcludedCells([good, timedOut]),
    /`good` × `t2` \[sonnet\] — excluded: Executor timed out/,
  );
  assert.match(renderExcludedCells([good]), /None — every attempted cell/);
});

// --- Report assembly: five-axis layout ----------------------------------------

test("renderReportMarkdown: five-axis layout in order, retired sections gone", () => {
  const c1 = cell("agentic-os", "t1", {
    judge: judgeResult({ craft: craftScores({ naming: 4, economy: 3 }) }),
    slop: slopMetrics({ duplicationDelta: 1 }),
    testResults: makeTestResults(true, 4, 0),
    anchors: {
      conventionHeld: true, turnsToGreen: 2, hitKnownTrap: false,
      evidence: "held the registry rule", grade: "held-by-abstraction",
    },
    filesOutsideExpectedSurface: [],
  });
  const c2 = cell("naked", "t1", {
    judge: judgeResult({ craft: craftScores({ naming: 1 }) }),
    slop: slopMetrics({ duplicationDelta: 3 }),
    testResults: makeTestResults(false, 2, 2),
    anchors: {
      conventionHeld: false, hitKnownTrap: true,
      evidence: "adopted the known-wrong convention", grade: "trap",
    },
    filesOutsideExpectedSurface: ["src/stray.ts"],
  });
  const report = makeReport({
    taskId: "t1",
    results: [c1, c2],
    pairwise: [pairwiseResult("agentic-os", "naked", "A", { taskId: "t1" })],
  });
  const md = renderReportMarkdown(report);

  const order = [
    "## Correctness",
    "## Memory effect (not scored)",
    "## Craft",
    "## Efficiency",
    "## Reliability",
    "## Blast radius",
    "## Excluded cells (not scored)",
    "## Behavioral signals (not scored)",
  ];
  const idx = order.map((h) => md.indexOf(h));
  order.forEach((h, i) => assert.ok(idx[i]! >= 0, `${h} present`));
  for (let i = 1; i < idx.length; i++) {
    assert.ok(idx[i - 1]! < idx[i]!, `${order[i - 1]} renders before ${order[i]}`);
  }

  // Retired sections and the retired headline never render.
  assert.doesNotMatch(md, /## Score matrix/);
  assert.doesNotMatch(md, /Cross-model comparison/);
  assert.doesNotMatch(md, /Consistent strengths/);
  assert.doesNotMatch(md, /Per-variant detail/);
  assert.doesNotMatch(md, /Run metrics \(not scored\)/);
  assert.doesNotMatch(md, /Top result/);
  assert.doesNotMatch(md, /undefined|NaN/);
});

test("a legacy (pre-five-axis) report renders through the new layout without retired sections", () => {
  const md = renderReportMarkdown(makeReport({ taskId: "t1,t2", results: multi }));
  assert.doesNotMatch(md, /## Score matrix/);
  assert.match(md, /## Correctness/);
  assert.match(md, /\| alpha \| sonnet \| — \| — \|/); // legacy correctness row
  assert.match(md, /No craft data/); // craft one-liner for legacy results
});

// --- JSON payload --------------------------------------------------------------

test("buildReportJson round-trips the five-axis fields and pairwise; legacy results omit them", () => {
  const newCell = cell("v", "t", {
    judge: judgeResult(),
    slop: slopMetrics(),
    testResults: makeTestResults(true, 3, 0),
    filesOutsideExpectedSurface: ["src/x.ts"],
    disqualified: true,
    repeat: 2,
  });
  const legacy = cell("old", "t");
  const pairwise = [pairwiseResult("v", "old", "A")];
  const report = makeReport({ results: [newCell, legacy], pairwise });

  const json = buildReportJson(report) as {
    results: Array<Record<string, unknown>>;
    pairwise: unknown;
    variantSummary: Array<Record<string, unknown>>;
  };

  const v = json.results.find((r) => r["variant"] === "v")!;
  assert.deepEqual(v["judge"], judgeResult());
  assert.deepEqual(v["slop"], slopMetrics());
  assert.deepEqual(v["testResults"], makeTestResults(true, 3, 0));
  assert.deepEqual(v["filesOutsideExpectedSurface"], ["src/x.ts"]);
  assert.equal(v["disqualified"], true);
  assert.equal(v["repeat"], 2);
  assert.equal(v["scored"], true);

  const o = json.results.find((r) => r["variant"] === "old")!;
  for (const k of [
    "judge", "slop", "testResults", "filesOutsideExpectedSurface", "disqualified", "repeat",
  ]) {
    assert.ok(!(k in o), `legacy result must omit ${k}`);
  }

  assert.deepEqual(json.pairwise, pairwise); // carried verbatim

  // Coverage counts survive; mean totals are never serialized.
  assert.deepEqual(json.variantSummary, [
    { variant: "v", executorModel: "sonnet", scoredCount: 1, attemptedCount: 1 },
    { variant: "old", executorModel: "sonnet", scoredCount: 1, attemptedCount: 1 },
  ]);
  assert.ok(!("meanTotal" in json.variantSummary[0]!));
});

test("buildReportJson stamps scored/excludedReason from the failure fields", () => {
  const scored = cell("v", "t1");
  const failed = cell("v", "t2", { executorFailure: "Executor timed out" });
  const json = buildReportJson(makeReport({ results: [scored, failed] })) as {
    results: Array<Record<string, unknown>>;
    variantSummary: Array<Record<string, unknown>>;
  };
  const ok = json.results.find((r) => r["taskId"] === "t1")!;
  assert.equal(ok["scored"], true);
  assert.ok(!("excludedReason" in ok));
  const bad = json.results.find((r) => r["taskId"] === "t2")!;
  assert.equal(bad["scored"], false);
  assert.equal(bad["excludedReason"], "Executor timed out");
  assert.deepEqual(json.variantSummary, [
    { variant: "v", executorModel: "sonnet", scoredCount: 1, attemptedCount: 2 },
  ]);
});

// --- --report regenerate (offline) ------------------------------------------

test("regenerateReport rewrites report.md/json with excluded cells surfaced, counts re-stamped", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bench-regen-"));
  try {
    const scored = cell("naked", "safe-redirect");
    const failed = cell("naked", "other-task", {
      executorFailure: "Executor timed out and the container was killed.",
    });
    const report = makeReport({
      taskId: "safe-redirect,other-task",
      taskTitle: "T",
      results: [scored, failed],
    });
    await fs.writeFile(path.join(dir, "report.json"), JSON.stringify(report, null, 2));

    const out = await regenerateReport(dir);
    assert.equal(out.mdPath, path.join(dir, "report.md"));

    const md = await fs.readFile(path.join(dir, "report.md"), "utf8");
    assert.match(md, /## Correctness/);
    assert.match(md, /## Excluded cells \(not scored\)/);
    assert.match(md, /`naked` × `other-task` \[sonnet\] — excluded: Executor timed out/);

    const json = JSON.parse(await fs.readFile(path.join(dir, "report.json"), "utf8"));
    const failedResult = json.results.find((r: { taskId: string }) => r.taskId === "other-task");
    assert.equal(failedResult.scored, false);
    assert.match(failedResult.excludedReason, /timed out/);
    assert.equal(json.variantSummary[0].scoredCount, 1);
    assert.equal(json.variantSummary[0].attemptedCount, 2);
    assert.ok(!("meanTotal" in json.variantSummary[0]));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("regenerateReport accepts a direct report.json path too", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bench-regen2-"));
  try {
    const report = makeReport({
      runId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      taskTitle: "T",
      results: [cell("naked", "t")],
    });
    const jsonPath = path.join(dir, "report.json");
    await fs.writeFile(jsonPath, JSON.stringify(report, null, 2));
    const out = await regenerateReport(jsonPath);
    assert.equal(out.jsonPath, jsonPath);
    assert.ok(await fs.stat(path.join(dir, "report.md")).then(() => true));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
