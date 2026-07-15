import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  aggregateCorrectness,
  aggregateCraft,
  aggregateCraftScore,
  aggregateMetrics,
  aggregatePairwise,
  aggregateReliability,
  aggregateSlop,
  buildCampaignMemoryEffect,
  buildMemoryEffect,
  buildReportJson,
  cellText,
  distinctModels,
  campaignAdherenceBreakdown,
  excludedReasonOf,
  formatScore,
  gradeSymbol,
  hasMemoryEffect,
  isScored,
  levelSparkline,
  regenerateReport,
  renderBehaviorComparison,
  renderBlastRadius,
  renderCrossTaskInsight,
  renderCampaignMemoryEffect,
  renderCorrectness,
  renderCraft,
  renderCraftScore,
  renderExcludedCells,
  renderJudgeCraft,
  renderMemoryEffect,
  renderPairwise,
  renderReliability,
  renderReportMarkdown,
  renderRunMetrics,
  renderSlop,
  sparkline,
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

// --- Sparklines ---------------------------------------------------------------

test("sparkline: empty input renders the empty string (no bogus glyph)", () => {
  assert.equal(sparkline([]), "");
});

test("sparkline: a single value renders one floor block (no range to normalize)", () => {
  assert.equal(sparkline([42]), "▁");
});

test("sparkline: a flat series (no spread) renders all floor blocks", () => {
  assert.equal(sparkline([5, 5, 5, 5]), "▁▁▁▁");
});

test("sparkline: a normal series spans floor→peak across its own min/max", () => {
  const s = sparkline([0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(s.length, 8);
  assert.equal(s[0], "▁"); // min → floor
  assert.equal(s[s.length - 1], "█"); // max → peak
  assert.equal(sparkline([1, 2, 3]), "▁▅█"); // evenly spaced 3-point ramp (mid rounds up)
});

test("levelSparkline: fixed 0..maxLevel scale — all-high reads tall, all-low reads flat", () => {
  assert.equal(levelSparkline([], 6), "");
  assert.equal(levelSparkline([6, 6, 6], 6), "███"); // absolute top, not self-normalized
  assert.equal(levelSparkline([0, 0, 0], 6), "▁▁▁"); // absolute floor
  assert.equal(levelSparkline([-3, 9], 6), "▁█"); // clamped into range
  assert.equal(levelSparkline([3, 3], 0), "▁▁"); // maxLevel 0 → floor, never NaN
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

// Regression guard for issue #9: the Correctness render must keep the three
// deterministic-verdict states visibly distinct, and must shout when a whole
// matrix ran with ZERO deterministic verdicts (the failure that shipped in run
// 5e89e754 — every cell silently fell back to the judge).
test("renderCorrectness: ran+passed / ran+failed / not-run are three DISTINCT Tests tokens", () => {
  const passed = renderCorrectness([cell("pass", "t1", { testResults: makeTestResults(true, 2, 0) })]);
  const failed = renderCorrectness([cell("fail", "t1", { testResults: makeTestResults(false, 0, 2) })]);
  const notRun = renderCorrectness([
    cell("skip", "t1", {
      judge: judgeResult({
        correctnessAssessment: { verdict: "likely_correct", evidence: ["looks wired"] },
      }),
    }),
  ]);
  assert.match(passed, /\| pass \| sonnet \| 1\/1 pass \|/); // ran + passed
  assert.match(failed, /\| fail \| sonnet \| 0\/1 pass \|/); // ran + failed (verdict, not absent)
  assert.match(notRun, /\| skip \| sonnet \| — \|/); // not run → em dash
  // A ran-but-failed verdict must NEVER collapse into the same token as not-run.
  assert.doesNotMatch(failed, /\| fail \| sonnet \| — \|/);
});

test("renderCorrectness: all-empty Tests column across the matrix raises a loud warning (issue #9)", () => {
  const allJudgeFallback = [
    cell("a", "t1", {
      judge: judgeResult({
        correctnessAssessment: { verdict: "likely_correct", evidence: ["ok"] },
      }),
    }),
    cell("a", "t2", {
      judge: judgeResult({
        correctnessAssessment: { verdict: "likely_incorrect", evidence: ["nope"] },
      }),
    }),
  ];
  const md = renderCorrectness(allJudgeFallback);
  assert.match(md, /No deterministic test verdict ran/);
  assert.match(md, /testCommand/);
});

test("renderCorrectness: warning is SUPPRESSED once any cell carries a deterministic verdict", () => {
  const armed = [
    cell("a", "t1", { testResults: makeTestResults(true, 1, 0) }),
    cell("a", "t2", {
      judge: judgeResult({
        correctnessAssessment: { verdict: "likely_correct", evidence: ["ok"] },
      }),
    }),
  ];
  assert.doesNotMatch(renderCorrectness(armed), /No deterministic test verdict ran/);
});

test("renderCorrectness: a legacy-only report (no evidence at all) does NOT trip the #9 warning", () => {
  // Neither testResults nor judge anywhere — nothing to score yet, so the
  // warning would be noise, not signal.
  assert.doesNotMatch(renderCorrectness([cell("old", "t1")]), /No deterministic test verdict ran/);
});

test("renderCorrectness: a judgeOnly-only matrix does NOT trip the #9 warning (issue #22)", () => {
  // Every cell is judgeOnly — a task that legitimately cannot run deterministic
  // tests in-container (needs a DB/service). An empty Tests column is EXPECTED
  // here, so the all-fallback warning must stay silent.
  const judgeOnlyMatrix = [
    cell("a", "prisma", {
      judgeOnly: true,
      judge: judgeResult({
        correctnessAssessment: { verdict: "likely_correct", evidence: ["fix looks right"] },
      }),
    }),
    cell("a", "webhook", {
      judgeOnly: true,
      judge: judgeResult({
        correctnessAssessment: { verdict: "likely_incorrect", evidence: ["missing replay guard"] },
      }),
    }),
  ];
  const md = renderCorrectness(judgeOnlyMatrix);
  assert.doesNotMatch(md, /No deterministic test verdict ran/);
  // The Tests column must SHOW the intentional grade, not a bare `—`, so a
  // reader can tell "judge-only by design" from "forgot the testCommand".
  assert.match(md, /\| a \| sonnet \| judge-only \|/);
});

test("renderCorrectness: a genuinely-untested non-judgeOnly matrix STILL trips the #9 warning", () => {
  // A judgeOnly cell alongside an ordinary cell that simply lacks a testCommand:
  // the ordinary cell is a real coverage gap (the #22 bug), so the warning fires
  // — judgeOnly suppression must not mask a genuine missing-testCommand defect.
  const mixed = [
    cell("a", "prisma", {
      judgeOnly: true,
      judge: judgeResult({
        correctnessAssessment: { verdict: "likely_correct", evidence: ["ok"] },
      }),
    }),
    cell("a", "safe-redirect", {
      judge: judgeResult({
        correctnessAssessment: { verdict: "likely_correct", evidence: ["looks wired"] },
      }),
    }),
  ];
  const md = renderCorrectness(mixed);
  assert.match(md, /No deterministic test verdict ran/);
  // Mixed row: the genuine gap stays `—`, but the judge-only cell is still
  // annotated so its intentional grading is not hidden by the gap token.
  assert.match(md, /\| a \| sonnet \| — \(1 judge-only\) \|/);
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

test("#13: renderMemoryEffect fires a ✓A headline callout ONLY when an anchor grades held-by-abstraction, before the legend", () => {
  const abstraction = anchored("os", "reg", {
    conventionHeld: true, turnsToGreen: 2, hitKnownTrap: false, evidence: "e",
    grade: "held-by-abstraction",
  });
  const md = renderMemoryEffect([abstraction]);
  assert.match(md, /✓A held-by-abstraction:.*os on `reg`/);
  assert.match(md, /strongest memory signal/);
  // Callout precedes the grade legend/grid.
  assert.ok(md.indexOf("✓A held-by-abstraction:") < md.indexOf("Grades:"), "callout before the legend");
  assert.ok(md.indexOf("✓A held-by-abstraction:") < md.indexOf("| Variant |"), "callout before the grid");

  // No abstraction hold → no callout (literal hold only).
  const literal = anchored("os", "reg", {
    conventionHeld: true, turnsToGreen: 2, hitKnownTrap: false, evidence: "e",
    grade: "held-by-literal",
  });
  assert.doesNotMatch(renderMemoryEffect([literal]), /✓A held-by-abstraction:/);
});

test("#14: memory-registry is flagged non-discriminating (✝ marker + footnote), other tasks are not", () => {
  const held = anchored("naked", "memory-registry", {
    conventionHeld: true, turnsToGreen: 15, hitKnownTrap: false, evidence: "e",
    grade: "held-by-literal",
  });
  const md = renderMemoryEffect([held]);
  assert.match(md, /\| `memory-registry` ✝ \|/); // dagger on the pivot column
  assert.match(md, /✝ non-discriminating:.*not a memory win/);
  // A different task carries no dagger.
  const other = anchored("naked", "memory-cents", {
    conventionHeld: true, hitKnownTrap: false, evidence: "e", grade: "held-by-literal",
  });
  const md2 = renderMemoryEffect([other]);
  assert.doesNotMatch(md2, /✝/);
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
  // Keeps the adhered/anchored fraction, now with the held/drift/trap breakdown (#15).
  assert.match(
    md,
    /\*\*Cumulative adherence:\*\* agentic-os 3\/3 adhered \(3 held · 0 drift · 0 trap\) \| naked 0\/3 \(0 held · 0 drift · 3 trap\) \| gstack 1\/3 \(1 held · 1 drift · 1 trap\)/,
  );
  assert.match(md, /\| Task \| agentic-os \| naked \| gstack \|/);
  // Byte-exact legacy cells (grade-less anchors) — integration tests depend on these.
  assert.match(md, /#2 `t3-created-at` \| ✓ held · 3t \| ✗ drift ⚠ trap · 3t \| ✓ held · 3t \|/);
  assert.match(md, /#0 `t1-search` \| — · 3t \|/);
  assert.doesNotMatch(md, /Grades:/); // legend only when graded verdicts exist
  assert.doesNotMatch(md, /undefined|NaN/);
});

test("#15: the cumulative headline distinguishes drift from trap at the aggregate level", () => {
  // naked hit the trap 3× (adopted the known-wrong convention); a drifting bundle
  // that wrote something-else-but-not-the-trap must read differently.
  const driftCamp = campaign("drifter", [false, false, false]); // anchored, not held, no trap
  const md = renderCampaignMemoryEffect([nakedCamp, driftCamp]);
  assert.match(md, /naked 0\/3 adhered \(0 held · 0 drift · 3 trap\)/);
  assert.match(md, /drifter 0\/3 \(0 held · 3 drift · 0 trap\)/);
  // Same 0/3 adhered, opposite failure mode — the whole point of the split.
});

test("#15: a fail-closed unknown gets its OWN bucket — drift stays strictly 'wrote something else'", () => {
  const mixed: CampaignResult = {
    variant: "os",
    executorModel: "sonnet",
    campaignId: "c",
    tasks: [
      campaignTaskResult(2, "t3", {
        anchors: { conventionHeld: true, hitKnownTrap: false, evidence: "e", grade: "held-by-literal" },
      }),
      campaignTaskResult(3, "t4", {
        anchors: { conventionHeld: false, hitKnownTrap: false, evidence: "e", grade: "unknown" },
      }),
      campaignTaskResult(4, "t5", {
        anchors: { conventionHeld: false, hitKnownTrap: false, evidence: "e", grade: "drift" },
      }),
    ],
  };
  const { held, drift, trap, unknown } = campaignAdherenceBreakdown(mixed);
  assert.deepEqual({ held, drift, trap, unknown }, { held: 1, drift: 1, trap: 0, unknown: 1 });
  const md = renderCampaignMemoryEffect([mixed]);
  assert.match(md, /os 1\/3 adhered \(1 held · 1 drift · 0 trap · 1 unknown\)/);
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

test("#37: renderCampaignMemoryEffect fires a ✓A headline callout when a campaign link grades held-by-abstraction, before the legend/trajectory", () => {
  const abstraction: CampaignResult = {
    variant: "agentic-os",
    executorModel: "sonnet",
    campaignId: "campaign-conventions",
    tasks: [
      campaignTaskResult(4, "t5-revisions", {
        anchors: { conventionHeld: true, hitKnownTrap: false, evidence: "reused helper", grade: "held-by-abstraction" },
      }),
    ],
  };
  const md = renderCampaignMemoryEffect([abstraction]);
  assert.match(md, /✓A held-by-abstraction:.*agentic-os on `t5-revisions`/);
  assert.match(md, /reused a prior abstraction rather than re-emitting the convention literal/);
  assert.match(md, /Mechanical, not scored\./);
  // Headlined: before the legend and the trajectory grid, not buried in a cell.
  assert.ok(md.indexOf("✓A held-by-abstraction:") < md.indexOf("Grades:"), "callout before the legend");
  assert.ok(md.indexOf("✓A held-by-abstraction:") < md.indexOf("| Task |"), "callout before the trajectory");
});

test("#37: no ✓A callout when no campaign link grades held-by-abstraction", () => {
  // graded chain of literal/trap/inertia — a hold, but never the abstraction generalization.
  const noAbstraction: CampaignResult = {
    variant: "gstack",
    executorModel: "sonnet",
    campaignId: "c",
    tasks: [
      campaignTaskResult(2, "l2", {
        anchors: { conventionHeld: true, hitKnownTrap: false, evidence: "e", grade: "held-by-literal" },
      }),
    ],
  };
  assert.doesNotMatch(renderCampaignMemoryEffect([noAbstraction]), /✓A held-by-abstraction:/);
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
  assert.match(md, /agentic-os 3\/3 adhered \(3 held · 0 drift · 0 trap\)/);
  assert.match(md, /naked 0\/3 \(0 held · 0 drift · 3 trap\)/);

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
  // One opponent (bravo), split 1–1 → head-to-head macro-average is also 0.5.
  assert.equal(alpha.headToHeadWinRate, 0.5);
  assert.deepEqual(alpha.headToHead, [{ opponent: "bravo", wins: 1, losses: 1 }]);
  assert.deepEqual(agg.positionBias, { aSlotWins: 2, decisive: 2 });

  const md = renderPairwise(comparisons);
  assert.match(md, /- alpha vs bravo: 1–1 \(1 ties\)/);
  assert.match(md, /\| alpha \| 50% \| 50% \| 2 \| 1–1–1 \|/);
  assert.match(md, /A-slot won 2 of 2 decisive comparisons \(expected ≈50%\)/);
});

test("renderPairwise: ties-only variant renders — win rate; absent pairwise is a one-liner", () => {
  const agg = aggregatePairwise([pairwiseResult("a1", "b1", "tie")]);
  assert.equal(agg.variants[0]!.headToHeadWinRate, null); // no decisive opponent
  const md = renderPairwise([pairwiseResult("a1", "b1", "tie")]);
  assert.match(md, /\| a1 \| — \| — \| 0 \| 0–0–1 \|/);
  assert.match(md, /A-slot won 0 of 0 decisive comparisons/);
  assert.match(renderPairwise(undefined), /No pairwise comparisons ran/);
  assert.match(renderPairwise([]), /No pairwise comparisons ran/);
});

test("renderCraft collapses to a one-liner for legacy results; renders all four subsections otherwise", () => {
  assert.match(renderCraft(multi), /No craft data/);
  const md = renderCraft([cell("v", "t", { slop: slopMetrics() })]);
  assert.match(md, /### Slop \(deterministic\)/);
  assert.match(md, /### Judge craft \(medians\)/);
  assert.match(md, /### Pairwise \(cross-bundle\)/);
  assert.match(md, /### Craft Score \(ranking summary\)/);
});

// --- Axis 3: Craft — deterministic slop: helper reuse / literal density (#16) ---

test("aggregateSlop sums helperReuse and literalDensity across cells; renderSlop shows both columns", () => {
  const s1 = cell("v", "t1", {
    slop: slopMetrics({ helperReuse: 2, literalDensity: 3 }),
  });
  const s2 = cell("v", "t2", {
    slop: slopMetrics({ helperReuse: 1, literalDensity: 4 }),
  });
  // Legacy cell without the new fields must contribute 0, not NaN.
  const legacy = cell("v", "t3", { slop: slopMetrics() });
  delete (legacy.slop as { helperReuse?: number }).helperReuse;
  delete (legacy.slop as { literalDensity?: number }).literalDensity;

  const [agg] = aggregateSlop([s1, s2, legacy]);
  assert.equal(agg!.helperReuse, 3);
  assert.equal(agg!.literalDensity, 7);

  const md = renderSlop([s1, s2, legacy]);
  assert.match(md, /Helper reuse \| Literal density/);
  assert.match(md, /\| 3 \| 7 \|/); // the two summed columns close the row
  assert.doesNotMatch(md, /undefined|NaN/);
});

// --- Axis 3: Craft — byte-identical slop rows regression (#10) ------------------

test("aggregateSlop keys each variant into its OWN bucket: different diffs → distinct residue sums", () => {
  // #10: agentic-os and gstack showed byte-identical slop rows despite distinct
  // diffs. This asserts the aggregator never collapses two variants into one
  // bucket or double-counts one — distinct residue inputs must stay distinct.
  const os = cell("agentic-os", "t1", {
    slop: slopMetrics({ residue: { todos: 0, debugLogging: 3, commentedOutCode: 1 } }),
  });
  const gstack = cell("gstack", "t1", {
    slop: slopMetrics({ residue: { todos: 1, debugLogging: 2, commentedOutCode: 0 } }),
  });
  const aggs = aggregateSlop([os, gstack]);
  const osAgg = aggs.find((a) => a.variant === "agentic-os")!;
  const gsAgg = aggs.find((a) => a.variant === "gstack")!;
  assert.equal(aggs.length, 2); // two buckets, not one shared bucket
  assert.deepEqual(osAgg.residue, { todos: 0, debugLogging: 3, commentedOutCode: 1 });
  assert.deepEqual(gsAgg.residue, { todos: 1, debugLogging: 2, commentedOutCode: 0 });
  assert.notDeepEqual(osAgg.residue, gsAgg.residue);
});

// --- Axis 3: Craft — composite Craft Score (#17) --------------------------------

const cs = (variant: string, slop: Partial<SlopMetrics>) =>
  cell(variant, "t", { slop: slopMetrics(slop) });

/** `n` comparisons in which `a` beats `b` (a always in the resolved A slot). */
const beats = (a: string, b: string, n: number): PairwiseResult[] =>
  Array.from({ length: n }, () => pairwiseResult(a, b, "A"));

/**
 * A fully-decisive round-robin with ≥5 comparisons between every adjacent pair,
 * so ranks stay separable and confident — isolating the composite formula from
 * the confidence layer. Head-to-head macro rates: gstack (vs ao .8, vs naked 1)
 * → .9; agentic-os (vs gstack .2, vs naked .8) → .5; naked (vs gstack 0, vs ao
 * .2) → .1. Each variant has 10 decisive comparisons.
 */
const csPairwise: PairwiseResult[] = [
  ...beats("gstack", "agentic-os", 4),
  ...beats("agentic-os", "gstack", 1),
  ...beats("agentic-os", "naked", 4),
  ...beats("naked", "agentic-os", 1),
  ...beats("gstack", "naked", 5),
];

test("aggregateCraftScore: head-to-head winRate × SlopHealth composite, ranked, matching the locked formula", () => {
  const results = [
    cs("gstack", {}), // clean: SlopHealth 1.0
    cs("agentic-os", { residue: { todos: 0, debugLogging: 1, commentedOutCode: 0 } }), // 0.90
    cs("naked", { duplicationDelta: 12 }), // dup saturates → SlopHealth 0
  ];
  const aggs = aggregateCraftScore(results, csPairwise);
  // Ranked highest-first.
  assert.deepEqual(aggs.map((a) => a.variant), ["gstack", "agentic-os", "naked"]);
  const g = aggs.find((a) => a.variant === "gstack")!;
  const a = aggs.find((a) => a.variant === "agentic-os")!;
  const n = aggs.find((a) => a.variant === "naked")!;
  assert.equal(g.slopHealth, 1);
  assert.equal(g.winRate, 0.9); // macro of (.8 vs ao, 1.0 vs naked)
  assert.equal(g.score, 93); // round(100·(0.7·0.9 + 0.3·1.0))
  assert.equal(g.decisiveTotal, 10);
  assert.equal(a.slopHealth, 0.9);
  assert.equal(a.winRate, 0.5); // macro of (.2 vs gstack, .8 vs naked)
  assert.equal(a.score, 62); // round(100·(0.7·0.5 + 0.3·0.90))
  assert.equal(n.slopHealth, 0);
  assert.equal(n.winRate, 0.1); // macro of (0 vs gstack, .2 vs ao)
  assert.equal(n.score, 7); // round(100·(0.7·0.1 + 0.3·0))
  assert.equal(g.slopOnly, false);
  // 10 decisive each, ≥5 between every adjacent pair → confident, separable.
  assert.equal(aggs.every((x) => x.lowConfidence), false);

  const md = renderCraftScore(results, csPairwise);
  assert.match(md, /\| 1 \| gstack \| sonnet \| 93 \| 90% \| 1\.00 \|/);
  assert.match(md, /\| 2 \| agentic-os \| sonnet \| 62 \| 50% \| 0\.90 \|/);
  // Each row's variant is immediately followed by `| sonnet` — no ≈ rank and no
  // low-confidence suffix — so the three positive matches already prove clean,
  // distinct, confident ranks.
  assert.match(md, /\| 3 \| naked \| sonnet \| 7 \| 10% \| 0\.00 \|/);
});

test("aggregatePairwise: macro-average ignores volume — beating only the weak variant earns no bonus", () => {
  // "farmer" pads its record by beating "naked" 9 times but splits 1–1 with the
  // strong "rival". GLOBAL rate = 10/12 ≈ .83 (volume inflates it); the honest
  // HEAD-TO-HEAD macro is (1.0 vs naked + 0.5 vs rival)/2 = .75 — one opponent,
  // one vote, no matter how many times it was farmed.
  const pw = [
    ...beats("farmer", "naked", 9),
    ...beats("farmer", "rival", 1),
    ...beats("rival", "farmer", 1),
  ];
  const farmer = aggregatePairwise(pw).variants.find((v) => v.variant === "farmer")!;
  assert.equal(farmer.winRate, 10 / 11); // global (10 W, 1 L), volume-inflated
  assert.equal(farmer.headToHeadWinRate, 0.75); // macro, volume-neutral
  assert.deepEqual(farmer.headToHead, [
    { opponent: "naked", wins: 9, losses: 0 },
    { opponent: "rival", wins: 1, losses: 1 },
  ]);
});

test("renderCraftScore: a variant backed by < MIN_CONFIDENT_DECISIVE comparisons is flagged low-confidence", () => {
  // "thin" scores on a single 3–1 head-to-head (4 decisive < 5) → score stands,
  // but the row is annotated ⚠ low-confidence (n=4).
  const results = [cs("thin", {}), cs("other", { duplicationDelta: 20 })];
  const pw = [...beats("thin", "other", 3), ...beats("other", "thin", 1)];
  const aggs = aggregateCraftScore(results, pw);
  const thin = aggs.find((a) => a.variant === "thin")!;
  assert.equal(thin.decisiveTotal, 4);
  assert.equal(thin.slopOnly, false); // 4 ≥ 3, so the rate is still used
  assert.equal(thin.lowConfidence, true);
  assert.equal(thin.winRate, 0.75); // single opponent → macro == that split
  const md = renderCraftScore(results, pw);
  assert.match(md, /thin ⚠ low-confidence \(n=4\)/);
});

test("renderCraftScore tie-band: close-and-thin AND lower won ≥1 → not separable (≈)", () => {
  // "top" beats "next" 2–1 (3 decisive < 5), both clean slop → scores 77 vs 53,
  // gap 24 < 25, and next won one of the three. Thin, close, not a shutout → the
  // second row must render ≈ (same band), not a distinct rank 2.
  const results = [cs("top", {}), cs("next", {})];
  const pw = [...beats("top", "next", 2), ...beats("next", "top", 1)];
  const aggs = aggregateCraftScore(results, pw);
  assert.deepEqual(aggs.map((a) => a.variant), ["top", "next"]); // top scores higher
  assert.equal(aggs[0]!.score, 77); // round(100·(0.7·0.667 + 0.3·1.0))
  assert.equal(aggs[1]!.score, 53); // round(100·(0.7·0.333 + 0.3·1.0)); gap 24 < 25
  const md = renderCraftScore(results, pw);
  assert.match(md, /\| 1 \| top ⚠ low-confidence \(n=3\) \| sonnet \|/);
  assert.match(md, /\| ≈ \| next ⚠ low-confidence \(n=3\) \| sonnet \|/); // not a rank 2
  assert.doesNotMatch(md, /\| 2 \|/);
});

test("renderCraftScore tie-band: a head-to-head SHUTOUT separates even on a thin sample and small gap", () => {
  // Chain of shutouts with SMALL score gaps (18, 17 — both < 25) so only the
  // shutout rule can separate them. Macro rates: hi (vs mid 1.0, vs lo .5)=.75;
  // mid (vs hi 0, vs lo 1.0)=.5; lo (vs hi .5, vs mid 0)=.25. mid is shut out by
  // hi (0–2); lo is shut out by mid (0–2). Each must get its own rank, not ≈.
  const results = [cs("hi", {}), cs("mid", {}), cs("lo", {})];
  const pw = [
    ...beats("hi", "mid", 2), // mid shut out by hi
    ...beats("mid", "lo", 2), // lo shut out by mid
    ...beats("hi", "lo", 1),
    ...beats("lo", "hi", 1), // hi–lo split 1–1
  ];
  const aggs = aggregateCraftScore(results, pw);
  assert.deepEqual(aggs.map((a) => a.variant), ["hi", "mid", "lo"]);
  assert.deepEqual(aggs.map((a) => a.score), [83, 65, 48]); // gaps 18, 17 (< 25)
  const md = renderCraftScore(results, pw);
  assert.match(md, /\| 1 \| hi ⚠ low-confidence \(n=4\) \| sonnet \| 83 \|/);
  assert.match(md, /\| 2 \| mid ⚠ low-confidence \(n=4\) \| sonnet \| 65 \|/); // shutout → rank 2
  assert.match(md, /\| 3 \| lo ⚠ low-confidence \(n=4\) \| sonnet \| 48 \|/); // shutout → rank 3
  assert.doesNotMatch(md, /\| ≈ \|/); // no banded rows
});

test("renderCraftScore tie-band: a ≥ 25-point score gap separates even on a thin sample", () => {
  // "a" beats "b" 3–1 (4 decisive < 5) and b won one (NOT a shutout), so only the
  // big-gap rule can separate them: a is clean (score 83), b's slop saturates
  // (score 18) → gap 65 ≥ 25 → distinct ranks, not ≈.
  const results = [cs("a", {}), cs("b", { duplicationDelta: 10 })];
  const pw = [...beats("a", "b", 3), ...beats("b", "a", 1)];
  const aggs = aggregateCraftScore(results, pw);
  assert.deepEqual(aggs.map((a) => a.variant), ["a", "b"]);
  assert.equal(aggs[0]!.score, 83);
  assert.equal(aggs[1]!.score, 18); // gap 65 ≥ 25
  const md = renderCraftScore(results, pw);
  assert.match(md, /\| 1 \| a ⚠ low-confidence \(n=4\) \| sonnet \| 83 \|/);
  assert.match(md, /\| 2 \| b ⚠ low-confidence \(n=4\) \| sonnet \| 18 \|/); // big gap → rank 2
  assert.doesNotMatch(md, /\| ≈ \|/); // no banded rows
});

test("aggregateCraftScore: missing pairwise drops the winRate term → round(100·SlopHealth), flagged slop-only", () => {
  const results = [cs("solo", {})]; // SlopHealth 1.0, no pairwise
  const [agg] = aggregateCraftScore(results, undefined);
  assert.equal(agg!.slopOnly, true);
  assert.equal(agg!.winRate, null);
  assert.equal(agg!.score, 100); // 100·SlopHealth, winRate never imputed
  const md = renderCraftScore(results, undefined);
  assert.match(md, /\(slop-only\)/);
  assert.match(md, /\| 1 \| solo \| sonnet \| 100 \| _\(slop-only\)_ \| 1\.00 \|/);
});

test("aggregateCraftScore: a win rate below the min-decisive threshold is untrusted → slop-only", () => {
  // "lo" has only 2 decisive comparisons (< 3) → its 100% rate is not trusted.
  const results = [cs("lo", {}), cs("hi", {})];
  const pw = [pairwiseResult("lo", "hi", "A"), pairwiseResult("lo", "hi", "A")];
  const lo = aggregateCraftScore(results, pw).find((a) => a.variant === "lo")!;
  assert.equal(lo.slopOnly, true);
  assert.equal(lo.winRate, null);
  assert.equal(lo.score, 100);
});

test("aggregateCraftScore: testTamper is a SOFT penalty via SlopHealth, never a disqualifier", () => {
  const results = [cs("t", { testTamper: { hits: 1, evidence: [] } })];
  const [agg] = aggregateCraftScore(results, undefined);
  // SlopHealth = 1 − 0.5·(1/1) = 0.5 → score 50; the cell still competes (not null).
  assert.equal(agg!.slopHealth, 0.5);
  assert.equal(agg!.score, 50);
  assert.equal(agg!.disqualified, false);
});

test("aggregateCraftScore: disqualified cells are excluded from inputs but the variant keeps ☠; all-disqualified → no score", () => {
  const partial = [
    cell("part", "t1", { slop: slopMetrics({ duplicationDelta: 0 }) }),
    cell("part", "t2", {
      slop: slopMetrics({ duplicationDelta: 100, testTamper: { hits: 9, evidence: [] } }),
      disqualified: true,
    }),
  ];
  const [pAgg] = aggregateCraftScore(partial, undefined);
  assert.equal(pAgg!.disqualified, true); // ☠ mark retained
  assert.equal(pAgg!.allDisqualified, false);
  assert.equal(pAgg!.slopHealth, 1); // the disqualified cell never entered SlopHealth
  assert.equal(pAgg!.score, 100);

  const allDq = [
    cell("gone", "t1", { slop: slopMetrics({ duplicationDelta: 5 }), disqualified: true }),
  ];
  const [aAgg] = aggregateCraftScore(allDq, undefined);
  assert.equal(aAgg!.allDisqualified, true);
  assert.equal(aAgg!.score, null);
  const md = renderCraftScore(allDq, undefined);
  assert.match(md, /\| — \| gone ☠ DISQUALIFIED \| sonnet \| ☠ \| — \| — \|/);
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
  // Per-run mean-of-dimensions dispersion: rep1 [2,3,3]=2.67, rep2 [4,3,3,3]=3.25, rep3 3.0.
  assert.ok(Math.abs(g!.craftScore!.min - 2.6667) < 0.001);
  assert.ok(Math.abs(g!.craftScore!.max - 3.25) < 0.001);
  // No testResults and no judge correctness assessment → no correctness verdict.
  assert.equal(g!.verdictRuns, 0);

  const md = renderReliability(rs);
  assert.match(md, /\| `t` × v \[sonnet\] \| 3 \| — \| 2\.7 \/ 3\.0 \/ 3\.3 \| \$0\.0082 \| 1\.6s \| 2–4 \| 3 \| 3 \| 3 \| 1 \| 3\/3 identical \|/);
  assert.match(md, /Craft score \(min\/mean\/max\)/);
  assert.match(md, /Targeting: spend repeats on the high-variance/);
  assert.match(md, /prisma-tx-deadlock/);
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

test("aggregateReliability: correctness verdict rate mixes deterministic tests and judge fallback", () => {
  const passed = cell("v", "t", {
    repeat: 1,
    testResults: makeTestResults(true, 3, 0), // deterministic pass
  });
  const judgedWrong = cell("v", "t", {
    repeat: 2,
    judge: judgeResult({
      correctnessAssessment: { verdict: "likely_incorrect", evidence: ["missing branch"] },
    }),
  });
  const noVerdict = cell("v", "t", { repeat: 3, judge: judgeResult() }); // null assessment → no verdict
  const [g] = aggregateReliability([passed, judgedWrong, noVerdict]);
  assert.equal(g!.correctRuns, 1);
  assert.equal(g!.verdictRuns, 2); // the null-assessment run contributes no verdict
  const md = renderReliability([passed, judgedWrong, noVerdict]);
  assert.match(md, /\| 1\/2 correct \|/);
});

test("renderRunMetrics adds a per-task exec-cost sparkline column", () => {
  const t1 = cell("v", "t1", { metrics: { executor: { wallMs: 10_000, costUsd: 0.02 } } });
  const t2 = cell("v", "t2", { metrics: { executor: { wallMs: 10_000, costUsd: 0.08 } } });
  const md = renderRunMetrics([t1, t2]);
  assert.match(md, /\| Variant \| Model \| Exec time \(s\) \| Exec cost \(USD\) \| Input tok \(uncached\) \| Output tok \| Turns \| Judge cost \(USD\) \| Cost\/task \|/);
  assert.match(md, /Cost\/task = per-task exec-cost sparkline/);
  // Two tasks, low→high cost → floor then peak block.
  assert.match(md, /\| v \| sonnet \|.*\| ▁█ \|/);
  assert.doesNotMatch(md, /undefined|NaN/);
});

test("renderRunMetrics renders — for the sparkline when no task reported a cost", () => {
  const noCost = cell("v", "t", { metrics: { executor: { wallMs: 8000 } } });
  const md = renderRunMetrics([noCost]);
  assert.match(md, /\| v \| sonnet \| 8.0s \| — \| — \| — \| — \| — \| — \|/);
});

test("renderCampaignMemoryEffect renders a per-bundle adherence sparkline across the chain", () => {
  const md = renderCampaignMemoryEffect(campaigns);
  assert.match(md, /Adherence sparkline per bundle/);
  // agentic-os held all 3 (grade-less hold ≈ level 4 of 6) → uniform mid block.
  assert.match(md, /- agentic-os `▆▆▆`/);
  // naked hit the trap all 3 → floor blocks.
  assert.match(md, /- naked `▁▁▁`/);
  // gstack held→drift→trap (levels 4,1,0) → descending.
  assert.match(md, /- gstack `▆▂▁`/);
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

// --- Cross-task insight (#18) -------------------------------------------------

/** A cell carrying a behavior block with the given LOC/sub-agent/cost/time. */
function behavCell(
  variant: string,
  taskId: string,
  linesAdded: number,
  subCount: number,
  costUsd: number,
  wallMs: number,
): VariantTaskResult {
  return cell(variant, taskId, {
    metrics: { executor: { wallMs, costUsd, numTurns: 5 } },
    behavior: behavior({
      subAgents: {
        count: subCount,
        byType: subCount > 0 ? { engineer: subCount } : {},
        dispatches: [],
      },
      changedFileShape: { source: 2, test: 1, docs: 0, linesAdded, linesRemoved: 10 },
    }),
  });
}

test("renderCrossTaskInsight: synthesizes the diff/efficiency contrast from behavioral fields", () => {
  const report = makeReport({
    executorModels: ["sonnet"],
    results: [
      behavCell("agentic-os", "safe-redirect", 195, 1, 0.2, 100_000),
      behavCell("naked", "safe-redirect", 1166, 0, 0.1, 50_000),
      behavCell("agentic-os", "csv-export", 120, 1, 0.2, 100_000),
      behavCell("naked", "csv-export", 130, 0, 0.1, 50_000),
    ],
  });
  const insight = renderCrossTaskInsight(report);
  // Leans on the widest gap (safe-redirect), names both variants + computed LOC.
  assert.match(insight, /^> /); // rendered as a blockquote callout
  assert.match(insight, /`agentic-os` used sub-agents on 2\/2 tasks/);
  assert.match(insight, /leaner diff than `naked` on `safe-redirect`/);
  assert.match(insight, /\(\+195 vs \+1,166 LOC\)/);
  // cost 0.40/0.20 = 2×; wall 200k/100k = 2× — both whole, so no tilde.
  assert.match(insight, /at 2× cost and 2× wall time\./);
  assert.doesNotMatch(insight, /undefined|NaN/);
});

test("renderCrossTaskInsight: lean variant used no sub-agents → drops the misleading 0/N pairing", () => {
  // agentic-os owns the HEAVY diff and the sub-agents; naked is lean with none.
  // Pairing "naked used sub-agents on 0/1 tasks, and produced a leaner diff"
  // would read as if leanness came despite them — so the clause must be dropped.
  const report = makeReport({
    taskId: "safe-redirect",
    results: [
      behavCell("agentic-os", "safe-redirect", 1166, 1, 0.2, 100_000),
      behavCell("naked", "safe-redirect", 195, 0, 0.1, 50_000),
    ],
  });
  const insight = renderCrossTaskInsight(report);
  assert.match(insight, /`naked` produced a leaner diff than `agentic-os`/);
  assert.doesNotMatch(insight, /used sub-agents on 0\//); // no misleading pairing
  // The heavier variant's sub-agent usage is the coherent contrast instead.
  assert.match(insight, /`agentic-os` used sub-agents on 1\/1 tasks\./);
  assert.doesNotMatch(insight, /undefined|NaN/);
});

test("renderCrossTaskInsight: no behavioral data → empty; assembly omits the section", () => {
  const report = makeReport({ results: [cell("alpha", "t1"), cell("bravo", "t1")] });
  assert.equal(renderCrossTaskInsight(report), "");
  assert.doesNotMatch(renderReportMarkdown(report), /## Cross-task insight/);
});

test("renderCrossTaskInsight: single variant degrades to a modest sub-agent line", () => {
  const report = makeReport({
    results: [
      behavCell("agentic-os", "t1", 100, 1, 0.2, 100_000),
      behavCell("agentic-os", "t2", 90, 0, 0.2, 100_000),
    ],
  });
  const insight = renderCrossTaskInsight(report);
  assert.match(insight, /`agentic-os` used sub-agents on 1\/2 tasks with behavioral data\./);
  assert.doesNotMatch(insight, /leaner diff/); // no cross-variant contrast to draw
});

// --- Focused report (--focus, #20) -------------------------------------------

test("renderReportMarkdown(focus): renders only the named axis + header", () => {
  const report = makeReport({
    taskId: "t1",
    results: [
      behavCell("agentic-os", "t1", 100, 1, 0.2, 100_000),
      behavCell("naked", "t1", 400, 0, 0.1, 50_000),
    ],
  });

  const craftMd = renderReportMarkdown(report, "craft");
  assert.match(craftMd, /# CLAUDE.md Variant Benchmark Report/); // header stays
  assert.match(craftMd, /Focused report: `craft` only/);
  assert.match(craftMd, /## Craft/);
  assert.doesNotMatch(craftMd, /## Correctness/);
  assert.doesNotMatch(craftMd, /## Efficiency/);
  assert.doesNotMatch(craftMd, /## Reliability/);
  assert.doesNotMatch(craftMd, /## Blast radius/);
  assert.doesNotMatch(craftMd, /## Cross-task insight/); // insight dropped in focus mode
  assert.doesNotMatch(craftMd, /## Behavioral signals/);

  const effMd = renderReportMarkdown(report, "efficiency");
  assert.match(effMd, /## Efficiency/);
  assert.doesNotMatch(effMd, /## Craft/);
  assert.doesNotMatch(effMd, /## Correctness/);
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
