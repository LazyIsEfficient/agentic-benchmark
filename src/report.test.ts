import assert from "node:assert/strict";
import { test } from "node:test";
import {
  aggregateByVariant,
  aggregateMetrics,
  distinctModels,
  formatScore,
  orderResultsForDetail,
  rankVariants,
  renderCrossModelTable,
  renderMatrix,
  renderPerModelMatrices,
  renderReportMarkdown,
  renderRunMetrics,
  renderStrengthsWeaknesses,
  renderVariantDetail,
} from "./report.js";
import type { Report, RunMetrics, VariantTaskResult } from "./types.js";

function result(
  variant: string,
  taskId: string,
  final: VariantTaskResult["final"],
  extra: Partial<VariantTaskResult> = {},
): VariantTaskResult {
  const dim = (score: number) => ({ score, justification: `${variant} just` });
  return {
    cellId: `${taskId}__${variant}__sonnet`,
    variant,
    taskId,
    executorModel: "sonnet",
    judgeModel: "opus",
    raw: {
      codeQuality: dim(final.codeQuality),
      testingCoverage: dim(final.testingCoverage),
      securityQuality: dim(final.securityQuality),
      documentation: dim(final.documentation),
      securityReviewPerformed: true,
      summary: `${variant} summary`,
    },
    final,
    total:
      final.codeQuality + final.testingCoverage + final.securityQuality + final.documentation,
    appliedCaps: [],
    signals: { testFilesPresent: true, securityReviewPerformed: true, changedFiles: [] },
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

// Single-task fixtures (must render identically to the pre-aggregation behavior).
const a = result("alpha", "t", { codeQuality: 25, testingCoverage: 35, securityQuality: 18, documentation: 8 }); // 86
const b = result("bravo", "t", { codeQuality: 15, testingCoverage: 10, securityQuality: 8, documentation: 2 }); // 35

test("formatScore keeps integers and renders means to one decimal", () => {
  assert.equal(formatScore(86), "86");
  assert.equal(formatScore(22.5), "22.5");
  assert.equal(formatScore(78), "78");
});

test("single task: mean equals the task score", () => {
  const aggs = aggregateByVariant([a]);
  assert.equal(aggs.length, 1);
  assert.equal(aggs[0]!.taskCount, 1);
  assert.equal(aggs[0]!.meanTotal, 86);
  assert.equal(aggs[0]!.mean.testingCoverage, 35);
});

test("renderMatrix aggregates to one row per variant, sorted by mean total", () => {
  const md = renderMatrix([b, a]);
  const lines = md.split("\n");
  assert.equal(lines.length, 4); // header + separator + 2 variant rows
  assert.ok(lines[2]!.includes("alpha"));
  assert.ok(lines[2]!.includes("**86**"));
  assert.ok(lines[3]!.includes("bravo"));
});

// --- Multi-task aggregation: 2 tasks × 2 variants ---------------------------

const aT1 = result("alpha", "t1", { codeQuality: 25, testingCoverage: 35, securityQuality: 18, documentation: 8 }); // 86
const aT2 = result("alpha", "t2", { codeQuality: 20, testingCoverage: 30, securityQuality: 15, documentation: 5 }); // 70
const bT1 = result("bravo", "t1", { codeQuality: 15, testingCoverage: 10, securityQuality: 8, documentation: 2 }); // 35
const bT2 = result("bravo", "t2", { codeQuality: 20, testingCoverage: 15, securityQuality: 8, documentation: 2 }); // 45
const multi = [bT2, aT1, bT1, aT2]; // deliberately unordered

test("aggregateByVariant groups runs and averages each dimension + total", () => {
  const aggs = aggregateByVariant(multi);
  assert.equal(aggs.length, 2); // no duplicate variant rows
  const alpha = aggs.find((v) => v.variant === "alpha")!;
  const bravo = aggs.find((v) => v.variant === "bravo")!;

  assert.equal(alpha.taskCount, 2);
  assert.equal(alpha.mean.codeQuality, 22.5); // (25+20)/2
  assert.equal(alpha.mean.testingCoverage, 32.5); // (35+30)/2
  assert.equal(alpha.mean.securityQuality, 16.5); // (18+15)/2
  assert.equal(alpha.mean.documentation, 6.5); // (8+5)/2
  assert.equal(alpha.meanTotal, 78); // (86+70)/2

  assert.equal(bravo.meanTotal, 40); // (35+45)/2
});

test("rankVariants ranks by mean total across tasks, not by best single pair", () => {
  const ranked = rankVariants(aggregateByVariant(multi));
  assert.deepEqual(ranked.map((v) => v.variant), ["alpha", "bravo"]);
});

test("renderMatrix on 2×2 still yields one row per variant with mean totals", () => {
  const md = renderMatrix(multi);
  const lines = md.split("\n");
  assert.equal(lines.length, 4);
  assert.ok(lines[2]!.includes("alpha"));
  assert.ok(lines[2]!.includes("**78**"));
  assert.ok(lines[2]!.includes("22.5"));
  assert.ok(lines[3]!.includes("bravo"));
  assert.ok(lines[3]!.includes("**40**"));
});

test("orderResultsForDetail keeps every (variant×task) run, ranked variant then task", () => {
  const ordered = orderResultsForDetail(multi);
  assert.equal(ordered.length, 4);
  assert.deepEqual(
    ordered.map((r) => `${r.variant}/${r.taskId}`),
    ["alpha/t1", "alpha/t2", "bravo/t1", "bravo/t2"],
  );
});

test("a variant with a failed run is flagged in the matrix", () => {
  const failed = result(
    "charlie",
    "t1",
    { codeQuality: 0, testingCoverage: 0, securityQuality: 0, documentation: 0 },
    { judgeFailure: "boom" },
  );
  const md = renderMatrix([a, failed]);
  assert.match(md, /charlie ⚠️/);
});

// --- Detail + strengths/weaknesses ------------------------------------------

test("renderVariantDetail emits the exact judge markdown format", () => {
  const md = renderVariantDetail(a);
  assert.match(md, /## Scores/);
  assert.match(md, /- \*\*Code Quality\*\*: 25\/30 —/);
  assert.match(md, /- \*\*Testing Coverage\*\*: 35\/40 —/);
  assert.match(md, /- \*\*Security Quality\*\*: 18\/20 —/);
  assert.match(md, /- \*\*Documentation\*\*: 8\/10 —/);
  assert.match(md, /\*\*Total Score: 86\/100\*\*/);
  assert.match(md, /## Summary/);
});

test("renderVariantDetail annotates applied caps and judge failure", () => {
  const capped = result(
    "capped",
    "t",
    { codeQuality: 20, testingCoverage: 10, securityQuality: 8, documentation: 5 },
    {
      appliedCaps: [
        { dimension: "testingCoverage", rawScore: 38, cappedTo: 10, reason: "no tests" },
      ],
      judgeFailure: "timeout",
    },
  );
  const md = renderVariantDetail(capped);
  assert.match(md, /capped from 38/);
  assert.match(md, /Judge failed: timeout/);
});

test("renderVariantDetail renders the total-cap note when a dimension:total cap fired", () => {
  const capped = result(
    "unsolved",
    "t",
    { codeQuality: 25, testingCoverage: 35, securityQuality: 18, documentation: 8 },
    {
      total: 30,
      appliedCaps: [
        {
          dimension: "total",
          rawScore: 86,
          cappedTo: 30,
          reason: "Correctness-gated task; judge found the core requirement unmet (taskSolved=false); total capped at 30.",
        },
      ],
    },
  );
  const md = renderVariantDetail(capped);
  assert.match(md, /\*\*Total Score: 30\/100\*\*/);
  assert.match(md, /Total capped from 86 to 30/);
  assert.match(md, /taskSolved=false/);
});

test("renderVariantDetail shows a truncation note when evidence was truncated", () => {
  const truncated = result(
    "trunc",
    "t",
    { codeQuality: 20, testingCoverage: 30, securityQuality: 15, documentation: 5 },
    { evidenceTruncated: true },
  );
  const md = renderVariantDetail(truncated);
  assert.match(md, /Evidence \(diff\/transcript\) was truncated/);
});

test("renderStrengthsWeaknesses names top and bottom variant by mean", () => {
  const md = renderStrengthsWeaknesses(multi);
  assert.match(md, /Code Quality.*strongest `alpha`.*weakest `bravo`/);
});

test("renderStrengthsWeaknesses flags dimensions where all variants averaged low", () => {
  const low1 = result("low1", "t", { codeQuality: 5, testingCoverage: 5, securityQuality: 3, documentation: 1 });
  const low2 = result("low2", "t", { codeQuality: 8, testingCoverage: 8, securityQuality: 2, documentation: 2 });
  const md = renderStrengthsWeaknesses([low1, low2]);
  assert.match(md, /systematic weakness/);
});

test("renderReportMarkdown (single model) keeps the plain Score matrix section", () => {
  const report: Report = {
    runId: "1e2f3a4b-5c6d-7e8f-9a0b-1c2d3e4f5a6b",
    generatedAt: "2026-07-07T00:00:00.000Z",
    taskId: "t1,t2",
    taskTitle: "Tasks",
    executorModels: ["sonnet"],
    judgeModel: "opus",
    results: multi,
  };
  const md = renderReportMarkdown(report);
  assert.match(md, /# CLAUDE.md Variant Benchmark Report/);
  assert.match(md, /Run ID.*1e2f3a4b-5c6d-7e8f-9a0b-1c2d3e4f5a6b/); // GUID in header
  assert.match(md, /## Score matrix/);
  assert.doesNotMatch(md, /Cross-model comparison/); // single model → no cross-model table
  assert.match(md, /## Consistent strengths \/ weaknesses/);
  assert.match(md, /## Run metrics \(not scored\)/);
  assert.match(md, /## Per-variant detail/);
  assert.match(md, /Top result.*alpha.*78/);
});

// --- Run metrics ------------------------------------------------------------

test("aggregateMetrics sums cost/tokens/time across a variant's tasks", () => {
  // alpha appears in both t1 and t2 → wallMs 10000+10000, cost 0.05+0.05.
  const aggs = aggregateMetrics(multi);
  const alpha = aggs.find((m) => m.variant === "alpha")!;
  assert.equal(alpha.wallMs, 20_000);
  assert.equal(alpha.execCostUsd, 0.1);
  assert.equal(alpha.inputTokens, 2000);
  assert.equal(alpha.outputTokens, 400);
  assert.equal(alpha.numTurns, 6);
  assert.equal(alpha.judgeCostUsd, 0.04);
});

test("aggregateMetrics is ordered like the score matrix (best mean total first)", () => {
  assert.deepEqual(
    aggregateMetrics(multi).map((m) => m.variant),
    ["alpha", "bravo"],
  );
});

test("renderRunMetrics renders a missing-cost run as em dash, never undefined/NaN", () => {
  const withCost = result("hascost", "t", {
    codeQuality: 20, testingCoverage: 20, securityQuality: 10, documentation: 5,
  });
  const noCost = result(
    "nocost",
    "t",
    { codeQuality: 20, testingCoverage: 20, securityQuality: 10, documentation: 5 },
    { metrics: { executor: { wallMs: 8000 } } }, // no cost/usage/turns
  );
  const md = renderRunMetrics([withCost, noCost]);
  assert.match(md, /NOT part of the \/100/);
  assert.match(md, /\| Variant \| Model \| Exec time/); // Model column present
  assert.match(md, /\| hascost \| sonnet \| 10.0s \| \$0.0500 \|/);
  // nocost row shows em dashes, not undefined/NaN.
  assert.match(md, /\| nocost \| sonnet \| 8.0s \| — \| — \| — \| — \| — \|/);
  assert.doesNotMatch(md, /undefined|NaN/);
});

// --- Executor model dimension (variant × task × model) ----------------------

const alphaSon = result("alpha", "t", { codeQuality: 25, testingCoverage: 35, securityQuality: 18, documentation: 8 }, { executorModel: "sonnet" }); // 86
const alphaOpus = result("alpha", "t", { codeQuality: 20, testingCoverage: 30, securityQuality: 15, documentation: 5 }, { executorModel: "opus" }); // 70
const bravoSon = result("bravo", "t", { codeQuality: 15, testingCoverage: 10, securityQuality: 8, documentation: 2 }, { executorModel: "sonnet" }); // 35
const bravoOpus = result("bravo", "t", { codeQuality: 20, testingCoverage: 15, securityQuality: 8, documentation: 5 }, { executorModel: "opus" }); // 48
const crossModel = [alphaSon, alphaOpus, bravoSon, bravoOpus];

test("distinctModels returns models in first-seen order", () => {
  assert.deepEqual(distinctModels(crossModel), ["sonnet", "opus"]);
});

test("aggregateByVariant groups by (variant, model) — never averaging across models", () => {
  const aggs = aggregateByVariant(crossModel);
  assert.equal(aggs.length, 4);
  const opusAlpha = aggs.find((v) => v.variant === "alpha" && v.executorModel === "opus")!;
  assert.equal(opusAlpha.meanTotal, 70);
  const sonAlpha = aggs.find((v) => v.variant === "alpha" && v.executorModel === "sonnet")!;
  assert.equal(sonAlpha.meanTotal, 86);
});

test("renderCrossModelTable: rows = variant, columns = models, best marked with star", () => {
  const md = renderCrossModelTable(crossModel);
  assert.match(md, /\| Variant \| sonnet \/100 \| opus \/100 \|/);
  // alpha: sonnet 86 is best (★), opus 70.
  assert.match(md, /\| alpha \| 86 ★ \| 70 \|/);
  // bravo: opus 48 is best (★), sonnet 35.
  assert.match(md, /\| bravo \| 35 \| 48 ★ \|/);
});

test("renderCrossModelTable renders a missing (variant,model) cell as em dash", () => {
  // alpha only ran on sonnet; opus column must show — not crash.
  const md = renderCrossModelTable([alphaSon, bravoOpus]);
  assert.match(md, /\| alpha \| 86 ★ \| — \|/);
  assert.doesNotMatch(md, /undefined|NaN/);
});

test("renderPerModelMatrices renders one dimension matrix per model", () => {
  const md = renderPerModelMatrices(crossModel);
  assert.match(md, /### Model: sonnet/);
  assert.match(md, /### Model: opus/);
  // Within sonnet, alpha (86) ranks above bravo (35).
  const sonnetIdx = md.indexOf("### Model: sonnet");
  const opusIdx = md.indexOf("### Model: opus");
  const sonnetBlock = md.slice(sonnetIdx, opusIdx);
  assert.ok(sonnetBlock.indexOf("alpha") < sonnetBlock.indexOf("bravo"));
});

test("aggregateMetrics keys by (variant, model) and orders by mean total", () => {
  const aggs = aggregateMetrics(crossModel);
  assert.deepEqual(
    aggs.map((m) => `${m.variant}/${m.executorModel}`),
    ["alpha/sonnet", "alpha/opus", "bravo/opus", "bravo/sonnet"],
  );
});

test("renderReportMarkdown (multi model) shows cross-model + per-model sections", () => {
  const report: Report = {
    runId: "1e2f3a4b-5c6d-7e8f-9a0b-1c2d3e4f5a6b",
    generatedAt: "2026-07-07T00:00:00.000Z",
    taskId: "t",
    taskTitle: "Task",
    executorModels: ["sonnet", "opus"],
    judgeModel: "opus",
    results: crossModel,
  };
  const md = renderReportMarkdown(report);
  assert.match(md, /## Cross-model comparison \(Total \/100\)/);
  assert.match(md, /## Per-model score matrices/);
  assert.match(md, /### Model: sonnet/);
  assert.doesNotMatch(md, /## Score matrix/); // replaced by the multi-model sections
  assert.match(md, /Top result.*alpha @ sonnet.*86/);
});
