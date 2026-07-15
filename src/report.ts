import fs from "node:fs/promises";
import path from "node:path";
import { fmtCost, fmtInt, fmtSeconds, fmtTokens } from "./metrics.js";
import type {
  AnchorGrade,
  AnchorResult,
  CampaignResult,
  CampaignTaskResult,
  CraftDimension,
  PairwiseResult,
  Report,
  VariantTaskResult,
} from "./types.js";

// --- Pure rendering (unit-tested) -------------------------------------------

/** Format a score for display: integers as-is, means to one decimal. */
export function formatScore(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/**
 * A cell is SCORED iff it produced a real judge verdict — executor OK and no
 * judge failure (timeouts already set executorFailure). Derived purely from the
 * failure fields, so it recomputes identically on `--report` regenerate. A
 * genuine judge-0 (no failure fields) is scored and counts; the failure path
 * never fabricates a counting 0.
 */
export function isScored(r: VariantTaskResult): boolean {
  return !r.executorFailure && !r.judgeFailure;
}

/** Reason a cell was excluded from aggregation, or undefined if scored. */
export function excludedReasonOf(r: VariantTaskResult): string | undefined {
  if (r.judgeFailure) return r.judgeFailure;
  if (r.executorFailure) return r.executorFailure;
  return undefined;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Population standard deviation (n divisor). 0 for a single value. */
function stddev(values: number[]): number {
  const m = mean(values);
  return Math.sqrt(mean(values.map((v) => (v - m) ** 2)));
}

// --- Sparklines (pure, observational) ---------------------------------------

/** Unicode block ramp, low→high, for inline sparklines. */
const SPARK_RAMP = "▁▂▃▄▅▆▇█";

/**
 * Inline unicode sparkline over a numeric series, min/max-normalized across the
 * series itself so the shape reads relative to its own range. Empty series →
 * `""`; a single value or a flat series (no spread) → the lowest block repeated.
 * Observational only — never a score component.
 */
export function sparkline(values: number[]): string {
  if (values.length === 0) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const top = SPARK_RAMP.length - 1;
  return values
    .map((v) => SPARK_RAMP[span === 0 ? 0 : Math.round(((v - min) / span) * top)])
    .join("");
}

/**
 * Sparkline over pre-computed levels on a FIXED `0..maxLevel` scale (absolute,
 * not self-normalized) — so an all-high series reads tall and an all-low series
 * reads short, instead of both collapsing to the floor. Used by the campaign
 * adherence trajectory, where each grade's ABSOLUTE strength is the point.
 * Levels are clamped into range; `maxLevel <= 0` → the floor block.
 */
export function levelSparkline(levels: number[], maxLevel: number): string {
  if (levels.length === 0) return "";
  const top = SPARK_RAMP.length - 1;
  return levels
    .map((lv) => {
      const clamped = Math.max(0, Math.min(lv, maxLevel));
      return SPARK_RAMP[maxLevel <= 0 ? 0 : Math.round((clamped / maxLevel) * top)];
    })
    .join("");
}

/** Distinct executor models in first-seen order. */
export function distinctModels(results: VariantTaskResult[]): string[] {
  const seen: string[] = [];
  for (const r of results) {
    if (!seen.includes(r.executorModel)) seen.push(r.executorModel);
  }
  return seen;
}

const SEP = " ";

/** One (variant × executorModel) group with its member cells, first-seen order. */
interface VariantModelGroup {
  variant: string;
  executorModel: string;
  members: VariantTaskResult[];
}

/**
 * Group flat results into one bucket per (variant, executorModel) in first-seen
 * order. The shared spine of every five-axis aggregator — grouping stays
 * mechanical and identical across axes; each axis only decides which members
 * count and what to compute.
 */
function groupByVariantModel(results: VariantTaskResult[]): VariantModelGroup[] {
  const order: string[] = [];
  const groups = new Map<string, VariantTaskResult[]>();
  for (const r of results) {
    const key = `${r.variant}${SEP}${r.executorModel}`;
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)!.push(r);
  }
  return order.map((key) => {
    const members = groups.get(key)!;
    return {
      variant: members[0]!.variant,
      executorModel: members[0]!.executorModel,
      members,
    };
  });
}

/** `☠ DISQUALIFIED`-suffixed variant label when any member cell was disqualified. */
function variantLabelWithDisqualification(variant: string, disqualified: boolean): string {
  return disqualified ? `${variant} ☠ DISQUALIFIED` : variant;
}

// --- Campaign links as pseudo-cells ------------------------------------------

/**
 * Project campaign links into pseudo-cells so the per-cell aggregations
 * (correctness tallies, craft medians, slop means, blast radius) see each link
 * exactly like a single-shot cell, keyed by the same (variant × model). Links
 * have no cellId, so the pseudo-cell is identified as
 * `<campaignId>[<linkIndex>:<taskId>] (<variant> × <model>)`.
 *
 * A FAILED link (executor or judge — links carry one `failure` field) keeps
 * only its identity plus `executorFailure`, dropping the five-axis fields:
 * failed links are coverage gaps and contribute to no tally, mirroring how
 * executor-failed single cells are excluded. These pseudo-cells are rendering
 * plumbing only — never persisted to report.json.
 */
function campaignLinkCells(
  campaigns: CampaignResult[] | undefined,
): VariantTaskResult[] {
  if (!campaigns) return [];
  const cells: VariantTaskResult[] = [];
  for (const c of campaigns) {
    for (const t of c.tasks) {
      const base: VariantTaskResult = {
        cellId: `${c.campaignId}[${t.index}:${t.taskId}] (${c.variant} × ${c.executorModel})`,
        variant: c.variant,
        taskId: t.taskId,
        executorModel: c.executorModel,
        judgeModel: "", // links don't record it; no aggregate consumes it
        metrics: { executor: t.metrics },
      };
      if (t.failure) {
        cells.push({ ...base, executorFailure: t.failure });
        continue;
      }
      cells.push({
        ...base,
        ...(t.judge !== undefined ? { judge: t.judge } : {}),
        ...(t.slop !== undefined ? { slop: t.slop } : {}),
        ...(t.testResults !== undefined ? { testResults: t.testResults } : {}),
        ...(t.filesOutsideExpectedSurface !== undefined
          ? { filesOutsideExpectedSurface: t.filesOutsideExpectedSurface }
          : {}),
        ...(t.disqualified !== undefined ? { disqualified: t.disqualified } : {}),
      });
    }
  }
  return cells;
}

/** Single cells plus campaign links as pseudo-cells, in that order. */
function withCampaignLinks(
  results: VariantTaskResult[],
  campaigns: CampaignResult[] | undefined,
): VariantTaskResult[] {
  const links = campaignLinkCells(campaigns);
  return links.length === 0 ? results : [...results, ...links];
}

/**
 * List every excluded (variant, model, task) with its reason, so a variant that
 * fails often can't look strong from a high partial coverage — the counts in
 * the tables plus this list make the gaps explicit.
 */
export function renderExcludedCells(results: VariantTaskResult[]): string {
  const excluded = results
    .filter((r) => !isScored(r))
    .sort(
      (a, b) =>
        a.variant.localeCompare(b.variant) ||
        a.executorModel.localeCompare(b.executorModel) ||
        a.taskId.localeCompare(b.taskId),
    );
  if (excluded.length === 0) {
    return "_None — every attempted cell produced a judged result._";
  }
  return excluded
    .map(
      (r) =>
        `- \`${r.variant}\` × \`${r.taskId}\` [${r.executorModel}] — excluded: ${excludedReasonOf(r) ?? "unknown reason"}`,
    )
    .join("\n");
}

// --- Axis 1: Correctness ------------------------------------------------------

/**
 * Correctness evidence for one (variant × model) unit. Tested cells (a
 * deterministic testCommand verdict) and untested cells (the judge's hedged
 * read) are DIFFERENT evidence classes — they are tallied side by side and
 * never blended into one number.
 */
export interface CorrectnessAggregate {
  variant: string;
  executorModel: string;
  /** All cells attempted for this unit. */
  attemptedCount: number;
  /** Cells with a deterministic testCommand verdict. */
  testedCount: number;
  /** Tested cells whose testCommand exited 0. */
  testedPassCount: number;
  /**
   * Untested cells by judge-fallback verdict. A cell whose judge is missing
   * (or returned no assessment) counts as `unknown` — fail closed, never
   * guessed correct.
   */
  fallback: { likelyCorrect: number; likelyIncorrect: number; unknown: number };
  /**
   * True when NO member cell carries either evidence class (an old-pipeline
   * report) — the row renders `—` instead of a fabricated `unknown` tally.
   */
  legacy: boolean;
  /** True when any member cell was disqualified (☠ marker in the table). */
  hasDisqualified: boolean;
}

/**
 * Tally correctness evidence per (variant × model): deterministic test verdicts
 * for tested cells, judge-fallback verdicts for untested ones. Executor-failed
 * cells enter NEITHER population — they are coverage gaps already reported
 * under Excluded cells, and tallying them as `unknown` here would double-count
 * the same failure. Pure; first-seen group order.
 */
export function aggregateCorrectness(
  results: VariantTaskResult[],
): CorrectnessAggregate[] {
  return groupByVariantModel(results).map(({ variant, executorModel, members }) => {
    const eligible = members.filter((r) => !r.executorFailure);
    const tested = eligible.filter((r) => r.testResults !== undefined);
    const untested = eligible.filter((r) => r.testResults === undefined);
    const fallback = { likelyCorrect: 0, likelyIncorrect: 0, unknown: 0 };
    for (const r of untested) {
      const verdict = r.judge?.correctnessAssessment?.verdict ?? "unknown";
      if (verdict === "likely_correct") fallback.likelyCorrect++;
      else if (verdict === "likely_incorrect") fallback.likelyIncorrect++;
      else fallback.unknown++;
    }
    return {
      variant,
      executorModel,
      attemptedCount: members.length,
      testedCount: tested.length,
      testedPassCount: tested.filter((r) => r.testResults!.ok).length,
      fallback,
      legacy: members.every(
        (r) => r.testResults === undefined && r.judge === undefined,
      ),
      hasDisqualified: members.some((r) => r.disqualified === true),
    };
  });
}

/**
 * The Correctness table: one row per (variant × model), tested and untested
 * populations in SEPARATE columns. Campaign links fold in as pseudo-cells
 * (failed links excluded). Legacy rows (no test verdicts, no judge)
 * render `—` honestly rather than an invented `unknown` count. Disqualified
 * cells stay visible here (with the ☠ marker) — disqualification only removes
 * them from craft aggregation.
 */
export function renderCorrectness(
  results: VariantTaskResult[],
  campaigns?: CampaignResult[],
): string {
  const header =
    `| Variant | Model | Tests | Judge fallback (untested cells) |\n` +
    `| --- | --- | --- | --- |`;
  const aggregates = aggregateCorrectness(withCampaignLinks(results, campaigns));
  const rows = aggregates.map((c) => {
    const name = variantLabelWithDisqualification(c.variant, c.hasDisqualified);
    if (c.legacy) return `| ${name} | ${c.executorModel} | — | — |`;
    const tests =
      c.testedCount > 0 ? `${c.testedPassCount}/${c.testedCount} pass` : "—";
    const untestedTotal =
      c.fallback.likelyCorrect + c.fallback.likelyIncorrect + c.fallback.unknown;
    const fb =
      untestedTotal > 0
        ? `likely_correct: ${c.fallback.likelyCorrect} · likely_incorrect: ${c.fallback.likelyIncorrect} · unknown: ${c.fallback.unknown}`
        : "—";
    return `| ${name} | ${c.executorModel} | ${tests} | ${fb} |`;
  });
  return [
    "_Tested cells report the deterministic testCommand verdict; untested cells report the judge's hedged read. Two different evidence classes — never blended into one number._",
    ...correctnessCoverageWarning(aggregates),
    "",
    [header, ...rows].join("\n"),
  ].join("\n");
}

/**
 * Regression guard for issue #9: a full matrix where the Tests column is `—` for
 * EVERY cell means 100% of Correctness silently fell back to the judge's hedged
 * read — the deterministic axis never contributed. That looked like a normal
 * report last time and shipped unnoticed. Surface it loudly instead: if there is
 * scored (non-legacy) correctness evidence but not a single deterministic test
 * verdict anywhere, prepend a warning. Returns [] (no warning) when the axis is
 * armed (some cell tested) or when there is nothing to score yet.
 */
function correctnessCoverageWarning(aggregates: CorrectnessAggregate[]): string[] {
  const scored = aggregates.some((c) => !c.legacy);
  const anyTested = aggregates.some((c) => c.testedCount > 0);
  if (!scored || anyTested) return [];
  return [
    "",
    "> ⚠️ **No deterministic test verdict ran in this matrix** — every Correctness cell fell back to the judge's hedged read. Declare a `testCommand` in the task's `meta.json` to arm the deterministic axis before trusting these numbers.",
  ];
}

// --- Axis 3: Craft --------------------------------------------------------------

/** The four craft dimensions in table-column order. */
const CRAFT_DIMENSIONS = ["naming", "structure", "consistency", "economy"] as const;

/**
 * Lower median of an ordinal sample: middle element for odd counts, the LOWER
 * of the two middles for even counts. Never averages — craft scores are
 * ordinal, and 2.5 is not a grade a judge can give. null for an empty sample.
 */
function lowerMedian(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
}

/**
 * Judge-craft medians for one (variant × model) unit. `unknown` scores never
 * enter a median (an unassessable dimension can't masquerade as a low score);
 * they are counted instead so the gap stays visible.
 */
export interface CraftAggregate {
  variant: string;
  executorModel: string;
  /** Cells contributing: scored, judged, and NOT disqualified. */
  cellCount: number;
  /** Lower median per dimension over numeric scores; null when none. */
  median: Record<CraftDimension, number | null>;
  /** Total `unknown` craft scores across all dimensions and cells. */
  unknownCount: number;
}

/**
 * Median craft scores per (variant × model) over scored, non-disqualified,
 * judged cells. Disqualified (adversarial) cells are EXCLUDED — gaming attempts
 * must not be averaged away. Pure; first-seen group order.
 */
export function aggregateCraft(results: VariantTaskResult[]): CraftAggregate[] {
  return groupByVariantModel(results).map(({ variant, executorModel, members }) => {
    const cells = members.filter(
      (r) => isScored(r) && r.disqualified !== true && r.judge !== undefined,
    );
    let unknownCount = 0;
    const median = {} as Record<CraftDimension, number | null>;
    for (const dim of CRAFT_DIMENSIONS) {
      const numeric: number[] = [];
      for (const r of cells) {
        const score = r.judge!.craft[dim].score;
        if (score === "unknown") unknownCount++;
        else numeric.push(score);
      }
      median[dim] = lowerMedian(numeric);
    }
    return { variant, executorModel, cellCount: cells.length, median, unknownCount };
  });
}

/**
 * Mechanical slop signals for one (variant × model) unit. Deterministic
 * counterpart to the judge's craft medians — computed from the diff, so it
 * can't be argued with.
 */
export interface SlopAggregate {
  variant: string;
  executorModel: string;
  /** Cells contributing (carry slop metrics and are NOT disqualified). */
  cellCount: number;
  /** Mean duplication delta; null when no cell carried slop metrics. */
  meanDuplicationDelta: number | null;
  /** Mean churn over cells with a non-null churnRatio; null when none. */
  meanChurnRatio: number | null;
  /** Summed leftover work-in-progress artifacts. */
  residue: { todos: number; debugLogging: number; commentedOutCode: number };
  /** Summed test-tamper hits. */
  testTamperHits: number;
  /** Summed helper-reuse call-sites (legacy cells lacking the field contribute 0). */
  helperReuse: number;
  /** Summed inlined magic-literal count (legacy cells lacking the field contribute 0). */
  literalDensity: number;
}

/**
 * Sum/average slop metrics per (variant × model). Exclusion rule: disqualified
 * cells are excluded (gaming attempts must not be averaged away), but
 * judge-failed (executor-ok) cells are INCLUDED — slop is deterministic and
 * does not depend on the judge, so a judge failure doesn't invalidate it.
 * Executor-failed cells are naturally absent (no diff ⇒ no slop computed).
 * churnRatio is only meaningful for campaign links, so its mean spans non-null
 * cells only. Pure; first-seen group order.
 */
export function aggregateSlop(results: VariantTaskResult[]): SlopAggregate[] {
  return groupByVariantModel(results).map(({ variant, executorModel, members }) => {
    const slops = members
      .filter((r) => r.slop !== undefined && r.disqualified !== true)
      .map((r) => r.slop!);
    const churns = slops
      .map((s) => s.churnRatio)
      .filter((c): c is number => c !== null);
    return {
      variant,
      executorModel,
      cellCount: slops.length,
      meanDuplicationDelta:
        slops.length > 0 ? mean(slops.map((s) => s.duplicationDelta)) : null,
      meanChurnRatio: churns.length > 0 ? mean(churns) : null,
      residue: {
        todos: slops.reduce((a, s) => a + s.residue.todos, 0),
        debugLogging: slops.reduce((a, s) => a + s.residue.debugLogging, 0),
        commentedOutCode: slops.reduce((a, s) => a + s.residue.commentedOutCode, 0),
      },
      testTamperHits: slops.reduce((a, s) => a + s.testTamper.hits, 0),
      helperReuse: slops.reduce((a, s) => a + (s.helperReuse ?? 0), 0),
      literalDensity: slops.reduce((a, s) => a + (s.literalDensity ?? 0), 0),
    };
  });
}

/** The deterministic-slop table (campaign links folded in), or a one-liner when no cell carries slop data. */
export function renderSlop(
  results: VariantTaskResult[],
  campaigns?: CampaignResult[],
): string {
  const aggs = aggregateSlop(withCampaignLinks(results, campaigns));
  if (aggs.every((a) => a.cellCount === 0)) {
    return "_No slop metrics recorded (legacy results)._";
  }
  const header =
    `| Variant | Model | Duplication Δ (mean) | Churn (mean) | TODOs | Debug logs | Commented-out | Test tamper | Helper reuse | Literal density |\n` +
    `| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`;
  const rows = aggs.map((a) => {
    if (a.cellCount === 0) {
      return `| ${a.variant} | ${a.executorModel} | — | — | — | — | — | — | — | — |`;
    }
    const dup = formatScore(a.meanDuplicationDelta!);
    const churn = a.meanChurnRatio === null ? "—" : a.meanChurnRatio.toFixed(2);
    return `| ${a.variant} | ${a.executorModel} | ${dup} | ${churn} | ${a.residue.todos} | ${a.residue.debugLogging} | ${a.residue.commentedOutCode} | ${a.testTamperHits} | ${a.helperReuse} | ${a.literalDensity} |`;
  });
  return [
    "_Mechanical diff signals — re-derivable by hand. Churn applies to campaign links only. Helper reuse (higher = shared helpers reused) and Literal density (higher = magic literals inlined) are summed over cells. Literal density is OBSERVATIONAL only — it never feeds SlopHealth/Craft Score, and legitimately literal-heavy code (HTTP status codes, string messages) can raise it. Disqualified cells excluded._",
    "",
    [header, ...rows].join("\n"),
  ].join("\n");
}

/** The judge-craft medians table (campaign links folded in), or a one-liner when no cell carries a judge verdict. */
export function renderJudgeCraft(
  results: VariantTaskResult[],
  campaigns?: CampaignResult[],
): string {
  const aggs = aggregateCraft(withCampaignLinks(results, campaigns));
  if (aggs.every((a) => a.cellCount === 0)) {
    return "_No judge craft verdicts recorded (legacy results)._";
  }
  const header =
    `| Variant | Model | Naming | Structure | Consistency | Economy | Unknown scores | Cells |\n` +
    `| --- | --- | --- | --- | --- | --- | --- | --- |`;
  const cell = (m: number | null) => (m === null ? "—" : String(m));
  const rows = aggs.map(
    (a) =>
      `| ${a.variant} | ${a.executorModel} | ${cell(a.median.naming)} | ${cell(a.median.structure)} | ${cell(a.median.consistency)} | ${cell(a.median.economy)} | ${a.unknownCount} | ${a.cellCount} |`,
  );
  return [
    "_Lower median (ordinal 0–4) over scored, non-disqualified cells. `unknown` scores never enter a median — they are counted instead (fail-closed)._",
    "",
    [header, ...rows].join("\n"),
  ].join("\n");
}

/** One head-to-head record: how a variant pair split its decisive comparisons. */
export interface PairwisePairAggregate {
  /** Display order fixed by the pair's first-seen comparison. */
  variantX: string;
  variantY: string;
  winsX: number;
  winsY: number;
  ties: number;
}

/** One variant's overall pairwise record across every pair it appeared in. */
export interface PairwiseVariantAggregate {
  variant: string;
  wins: number;
  losses: number;
  ties: number;
  /** wins/(wins+losses); null when the variant had no decisive comparison. */
  winRate: number | null;
}

/** Win/loss/tie tallies plus the A-slot position-bias audit. */
export interface PairwiseAggregate {
  /** Usable comparisons (judge-failed comparisons are dropped). */
  comparisons: number;
  pairs: PairwisePairAggregate[];
  variants: PairwiseVariantAggregate[];
  /** How often the "A" presentation slot won — should hover near 50%. */
  positionBias: { aSlotWins: number; decisive: number };
}

/**
 * Tally pairwise OVERALL winners per variant pair and per variant. Winners are
 * resolved through variantA/variantB (the post-randomization mapping), so the
 * "A"/"B" letters never leak into the tallies — except into the position-bias
 * audit, whose whole point is watching the presentation slot. Pure.
 */
export function aggregatePairwise(pairwise: PairwiseResult[]): PairwiseAggregate {
  const usable = pairwise.filter((p) => !p.judgeFailure);

  const pairOrder: string[] = [];
  const pairs = new Map<string, PairwisePairAggregate>();
  const variantOrder: string[] = [];
  const tallies = new Map<string, { wins: number; losses: number; ties: number }>();
  const tally = (variant: string) => {
    if (!tallies.has(variant)) {
      tallies.set(variant, { wins: 0, losses: 0, ties: 0 });
      variantOrder.push(variant);
    }
    return tallies.get(variant)!;
  };

  let aSlotWins = 0;
  let decisive = 0;
  for (const p of usable) {
    // Unordered pair identity (A/B order is randomized per call); display
    // orientation comes from the pair's first-seen comparison.
    const key = [p.variantA, p.variantB].sort().join(SEP);
    if (!pairs.has(key)) {
      pairs.set(key, {
        variantX: p.variantA,
        variantY: p.variantB,
        winsX: 0,
        winsY: 0,
        ties: 0,
      });
      pairOrder.push(key);
    }
    const pair = pairs.get(key)!;
    const a = tally(p.variantA);
    const b = tally(p.variantB);

    if (p.overall.winner === "tie") {
      pair.ties++;
      a.ties++;
      b.ties++;
      continue;
    }
    decisive++;
    if (p.overall.winner === "A") aSlotWins++;
    const winner = p.overall.winner === "A" ? p.variantA : p.variantB;
    const loser = p.overall.winner === "A" ? p.variantB : p.variantA;
    if (winner === pair.variantX) pair.winsX++;
    else pair.winsY++;
    tallies.get(winner)!.wins++;
    tallies.get(loser)!.losses++;
  }

  return {
    comparisons: usable.length,
    pairs: pairOrder.map((k) => pairs.get(k)!),
    variants: variantOrder.map((v) => {
      const t = tallies.get(v)!;
      const denom = t.wins + t.losses;
      return { variant: v, ...t, winRate: denom > 0 ? t.wins / denom : null };
    }),
    positionBias: { aSlotWins, decisive },
  };
}

/**
 * The Pairwise (cross-bundle) subsection: per-pair records, per-variant win
 * rates (ties excluded), and the position-bias audit line. One-liner when
 * pairwise judging didn't run.
 */
export function renderPairwise(pairwise: PairwiseResult[] | undefined): string {
  if (!pairwise || pairwise.length === 0) {
    return "_No pairwise comparisons ran._";
  }
  const agg = aggregatePairwise(pairwise);
  if (agg.comparisons === 0) {
    return "_Every pairwise comparison failed at the judge — no usable A/B verdicts._";
  }
  const pairLines = agg.pairs.map(
    (p) => `- ${p.variantX} vs ${p.variantY}: ${p.winsX}–${p.winsY} (${p.ties} ties)`,
  );
  const header = `| Variant | Win rate | W–L–T |\n| --- | --- | --- |`;
  const rows = agg.variants.map((v) => {
    const rate = v.winRate === null ? "—" : `${Math.round(v.winRate * 100)}%`;
    return `| ${v.variant} | ${rate} | ${v.wins}–${v.losses}–${v.ties} |`;
  });
  const bias = `_Position-bias audit: A-slot won ${agg.positionBias.aSlotWins} of ${agg.positionBias.decisive} decisive comparisons (expected ≈50%)._`;
  return [
    "_Same-cell A/B craft comparisons (overall winner per comparison). Win rate = wins/(wins+losses); ties excluded._",
    "",
    pairLines.join("\n"),
    "",
    [header, ...rows].join("\n"),
    "",
    bias,
  ].join("\n");
}

// --- Composite Craft Score (within-axis ranking summary) ---------------------

/**
 * Duplication cap for SlopHealth: a mean duplication Δ of ≥10 windows saturates
 * the duplication penalty to its full weight. Above this the metric stops
 * discriminating — a diff that copy-pastes 10 blocks is already maximally
 * duplicative for scoring purposes.
 */
const CRAFT_DUP_CAP = 10;
/**
 * Minimum DECISIVE pairwise comparisons (wins+losses, ties excluded) a variant
 * needs before its win rate is trusted in the composite. Below it the rate is
 * too noisy — one head-to-head swings it 0↔100% — so the score drops the
 * winRate term and renders `(slop-only)` rather than IMPUTE a rate. Chosen as
 * the smallest sample where a majority is not a single comparison.
 */
const MIN_DECISIVE_COMPARISONS = 3;

/** Clamp x into [lo, hi]. */
function clamp(x: number, lo: number, hi: number): number {
  return Math.min(Math.max(x, lo), hi);
}

/**
 * One variant×model's composite Craft Score — a WITHIN-Craft ranking summary,
 * never a cross-axis total (the lexicographic "axes are never summed" rule holds:
 * this combines only Craft's own sub-signals). See {@link renderCraftScore}.
 */
export interface CraftScoreAggregate {
  variant: string;
  executorModel: string;
  /** SlopHealth ∈ [0,1] from the deterministic slop means; null when no scorable cell. */
  slopHealth: number | null;
  /** Pairwise win rate folded into the score, or null when dropped (untrusted/missing). */
  winRate: number | null;
  /** Composite 0–100 score; null when no slop cell survives (all disqualified / no data). */
  score: number | null;
  /** True when the winRate term was dropped → `score = round(100·slopHealth)`. */
  slopOnly: boolean;
  /** True when any member cell was disqualified (adversarial) — the ☠ mark. */
  disqualified: boolean;
  /** True when EVERY member cell was disqualified: no inputs survive → ☠/no score. */
  allDisqualified: boolean;
}

/**
 * `SlopHealth = clamp(1 − min(meanDupΔ/10,1) − 0.1·(residueTotal/cells)
 * − 0.5·(tamperHits/cells), 0, 1)`. testTamper is a SOFT penalty here — it lowers
 * health but never disqualifies. null when the group carries no scorable slop
 * cell (all disqualified, or legacy cells without slop).
 */
function slopHealthOf(a: SlopAggregate): number | null {
  if (a.cellCount === 0 || a.meanDuplicationDelta === null) return null;
  const residueTotal =
    a.residue.todos + a.residue.debugLogging + a.residue.commentedOutCode;
  const dupPenalty = Math.min(a.meanDuplicationDelta / CRAFT_DUP_CAP, 1);
  const residuePenalty = 0.1 * (residueTotal / a.cellCount);
  const tamperPenalty = 0.5 * (a.testTamperHits / a.cellCount);
  return clamp(1 - dupPenalty - residuePenalty - tamperPenalty, 0, 1);
}

/**
 * Composite Craft Score per (variant × model), ordered as a ranking (highest
 * first; unscored rows last, otherwise first-seen-stable). Joins the
 * deterministic {@link aggregateSlop} SlopHealth with the pairwise win rate from
 * {@link aggregatePairwise} (matched by variant — comparisons never cross
 * models, so one variant win rate applies to each of its model rows). Missing or
 * low-sample pairwise drops the winRate term (renormalized to `100·slopHealth`,
 * flagged slop-only); disqualified cells are already excluded from the slop
 * inputs but their variant keeps the ☠ mark, and an all-disqualified variant
 * yields no score. Pure.
 */
export function aggregateCraftScore(
  results: VariantTaskResult[],
  pairwise?: PairwiseResult[],
  campaigns?: CampaignResult[],
): CraftScoreAggregate[] {
  const cells = withCampaignLinks(results, campaigns);
  const slopAggs = aggregateSlop(cells);
  const winRates = new Map<string, { rate: number | null; decisive: number }>();
  if (pairwise !== undefined && pairwise.length > 0) {
    for (const v of aggregatePairwise(pairwise).variants) {
      winRates.set(v.variant, { rate: v.winRate, decisive: v.wins + v.losses });
    }
  }
  const anyDisqByGroup = new Map<string, boolean>();
  for (const g of groupByVariantModel(cells)) {
    anyDisqByGroup.set(
      `${g.variant}${SEP}${g.executorModel}`,
      g.members.some((m) => m.disqualified === true),
    );
  }
  const rows: CraftScoreAggregate[] = slopAggs.map((a) => {
    const anyDisq = anyDisqByGroup.get(`${a.variant}${SEP}${a.executorModel}`) ?? false;
    const slopHealth = slopHealthOf(a);
    const wr = winRates.get(a.variant);
    const trusted =
      wr !== undefined && wr.rate !== null && wr.decisive >= MIN_DECISIVE_COMPARISONS;
    let score: number | null = null;
    let winRate: number | null = null;
    let slopOnly = false;
    if (slopHealth !== null) {
      if (trusted) {
        winRate = wr!.rate;
        score = Math.round(100 * (0.7 * winRate! + 0.3 * slopHealth));
      } else {
        slopOnly = true;
        score = Math.round(100 * slopHealth);
      }
    }
    return {
      variant: a.variant,
      executorModel: a.executorModel,
      slopHealth,
      winRate,
      score,
      slopOnly,
      disqualified: anyDisq,
      allDisqualified: slopHealth === null && anyDisq,
    };
  });
  return rows
    .map((r, i) => ({ r, i }))
    .sort((x, y) => {
      if (x.r.score === null && y.r.score === null) return x.i - y.i;
      if (x.r.score === null) return 1;
      if (y.r.score === null) return -1;
      return y.r.score - x.r.score || x.i - y.i;
    })
    .map(({ r }) => r);
}

/**
 * The Craft Score sub-table (4th under Craft): a within-axis ranking of the
 * variants by composite score. One-liner when no scorable slop cell exists.
 */
export function renderCraftScore(
  results: VariantTaskResult[],
  pairwise?: PairwiseResult[],
  campaigns?: CampaignResult[],
): string {
  const aggs = aggregateCraftScore(results, pairwise, campaigns);
  if (aggs.every((a) => a.score === null && !a.allDisqualified)) {
    return "_No craft score — no deterministic slop metrics to score._";
  }
  const header =
    `| Rank | Variant | Model | Craft Score | Win rate | Slop health |\n` +
    `| --- | --- | --- | --- | --- | --- |`;
  let rank = 0;
  const rows = aggs.map((a) => {
    const label = variantLabelWithDisqualification(a.variant, a.disqualified);
    if (a.score === null) {
      return `| — | ${label} | ${a.executorModel} | ${a.allDisqualified ? "☠" : "—"} | — | — |`;
    }
    rank++;
    const health = a.slopHealth === null ? "—" : a.slopHealth.toFixed(2);
    const wr = a.slopOnly ? "_(slop-only)_" : `${Math.round(a.winRate! * 100)}%`;
    return `| ${rank} | ${label} | ${a.executorModel} | ${a.score} | ${wr} | ${health} |`;
  });
  return [
    "_Within-Craft ranking summary — NOT a cross-axis total (axes are never summed; this combines only Craft's own sub-signals). `Score = round(100·(0.7·winRate + 0.3·SlopHealth))`, dup capped at " +
      `${CRAFT_DUP_CAP}; a variant with fewer than ${MIN_DECISIVE_COMPARISONS} decisive pairwise comparisons drops the winRate term and is flagged \`(slop-only)\` (never imputed). testTamper is a soft penalty via SlopHealth. Disqualified cells are excluded from the inputs but keep their ☠ mark._`,
    "",
    [header, ...rows].join("\n"),
  ].join("\n");
}

/**
 * The Craft axis: deterministic slop, judge-craft medians, pairwise win-rates,
 * and a composite Craft Score ranking — the qualitative residual read four ways.
 * The first three are independent reads never combined; the fourth is a
 * within-Craft ranking SUMMARY (still not a cross-axis total). Campaign links
 * fold into the slop and judge-craft tables as pseudo-cells of their
 * (variant × model). Collapses to a one-liner for legacy reports that carry none.
 */
export function renderCraft(
  results: VariantTaskResult[],
  pairwise?: PairwiseResult[],
  campaigns?: CampaignResult[],
): string {
  const hasCellData = withCampaignLinks(results, campaigns).some(
    (r) => r.judge !== undefined || r.slop !== undefined,
  );
  const hasPairwise = pairwise !== undefined && pairwise.length > 0;
  if (!hasCellData && !hasPairwise) {
    return "_No craft data — these results predate the five-axis judge (legacy report)._";
  }
  return [
    "### Slop (deterministic)",
    "",
    renderSlop(results, campaigns),
    "",
    "### Judge craft (medians)",
    "",
    renderJudgeCraft(results, campaigns),
    "",
    "### Pairwise (cross-bundle)",
    "",
    renderPairwise(pairwise),
    "",
    "### Craft Score (ranking summary)",
    "",
    renderCraftScore(results, pairwise, campaigns),
  ].join("\n");
}

// --- Axis 5: Reliability --------------------------------------------------------

/** Spread across the repeats of one (task × variant × model) cell. */
export interface ReliabilityGroup {
  taskId: string;
  variant: string;
  executorModel: string;
  /** Repeat runs in the group (always ≥ 2). */
  runCount: number;
  /** Population stddev of executor costUsd; null when <2 runs reported a cost. */
  costStddevUsd: number | null;
  /** Population stddev of executor wall time (always present on every run). */
  wallMsStddev: number;
  /** min–max craft score per dimension over judged runs; null when none numeric. */
  craftRange: Record<CraftDimension, { min: number; max: number } | null>;
  /**
   * Dispersion of a per-run composite Craft signal — each judge-OK run's mean
   * over its numeric craft dimensions — as min/mean/max across the repeats.
   * A per-run mean-of-dimensions, NOT the pairwise composite Craft Score (win
   * rate isn't per-run), so it stays computable from a single run. null when no
   * run carried a numeric craft dimension.
   */
  craftScore: { min: number; mean: number; max: number } | null;
  /**
   * Correctness verdict agreement across repeats: how many runs read correct out
   * of those with a determinable verdict (deterministic testResults.ok, else the
   * judge's likely_correct/likely_incorrect fallback). `verdictRuns` 0 ⇒ no run
   * yielded a verdict.
   */
  correctRuns: number;
  verdictRuns: number;
  /** Total `unknown` craft scores across the group's judge-OK runs. */
  craftUnknowns: number;
  /**
   * Judge-failed repeats in the group. Reported as their own count — a judge
   * failure is a coverage gap for the craft columns, not four `unknown` scores.
   */
  judgeFailures: number;
  /**
   * One label per anchored run: its grade when present, else a legacy label
   * derived from the booleans (held/drift/trap). Identical labels = the anchor
   * verdict is stable across repeats.
   */
  anchorGrades: string[];
}

/**
 * Group `--repeats` runs by (taskId × variant × model) and measure their
 * spread: cost/time stddev, craft score ranges, anchor-grade agreement. Only
 * cells with `repeat` set participate; groups need ≥2 members to say anything
 * about reliability. Executor-failed repeats are excluded ENTIRELY — they are
 * coverage gaps, and their wallMs=0 would fabricate spread. Judge-failed
 * repeats stay for cost/time and anchors (the executor ran) but are counted in
 * `judgeFailures` instead of the craft columns. Pure; first-seen group order.
 */
export function aggregateReliability(
  results: VariantTaskResult[],
): ReliabilityGroup[] {
  const order: string[] = [];
  const groups = new Map<string, VariantTaskResult[]>();
  for (const r of results) {
    if (r.repeat === undefined || r.executorFailure) continue;
    const key = `${r.taskId}${SEP}${r.variant}${SEP}${r.executorModel}`;
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)!.push(r);
  }

  return order
    .map((key) => groups.get(key)!)
    .filter((members) => members.length >= 2)
    .map((members) => {
      const first = members[0]!;
      const costs = members
        .map((r) => r.metrics.executor.costUsd)
        .filter((c): c is number => c !== undefined);

      const craftRange = {} as Record<CraftDimension, { min: number; max: number } | null>;
      let craftUnknowns = 0;
      for (const dim of CRAFT_DIMENSIONS) {
        const numeric: number[] = [];
        for (const r of members) {
          if (r.judgeFailure) continue; // counted in judgeFailures, not as unknowns
          const score = r.judge?.craft[dim].score;
          if (score === undefined) continue;
          if (score === "unknown") craftUnknowns++;
          else numeric.push(score);
        }
        craftRange[dim] =
          numeric.length > 0
            ? { min: Math.min(...numeric), max: Math.max(...numeric) }
            : null;
      }

      // Per-run composite craft signal: each judge-OK run's mean over its own
      // numeric dimensions. Dispersion (min/mean/max) across the repeats.
      const perRunCraft: number[] = [];
      for (const r of members) {
        if (r.judgeFailure) continue;
        const nums: number[] = [];
        for (const dim of CRAFT_DIMENSIONS) {
          const score = r.judge?.craft[dim].score;
          if (typeof score === "number") nums.push(score);
        }
        if (nums.length > 0) perRunCraft.push(mean(nums));
      }

      // Per-run correctness verdict rate across the repeats: deterministic test
      // outcome when present, else the judge's likely_correct/incorrect fallback.
      const verdicts = members
        .map((r) => runCorrectness(r))
        .filter((v): v is boolean => v !== undefined);

      return {
        taskId: first.taskId,
        variant: first.variant,
        executorModel: first.executorModel,
        runCount: members.length,
        costStddevUsd: costs.length >= 2 ? stddev(costs) : null,
        wallMsStddev: stddev(members.map((r) => r.metrics.executor.wallMs)),
        craftRange,
        craftScore:
          perRunCraft.length > 0
            ? {
                min: Math.min(...perRunCraft),
                mean: mean(perRunCraft),
                max: Math.max(...perRunCraft),
              }
            : null,
        correctRuns: verdicts.filter(Boolean).length,
        verdictRuns: verdicts.length,
        craftUnknowns,
        judgeFailures: members.filter((r) => r.judgeFailure !== undefined).length,
        anchorGrades: members
          .filter((r) => r.anchors !== undefined)
          .map((r) => anchorGradeLabel(r.anchors!)),
      };
    });
}

/**
 * One run's correctness verdict for reliability agreement: the deterministic
 * testCommand outcome when a run has one, else the judge's fallback read
 * (likely_correct → true, likely_incorrect → false). `undefined` when neither
 * evidence class yielded a verdict — that run simply doesn't enter the rate.
 */
function runCorrectness(r: VariantTaskResult): boolean | undefined {
  if (r.testResults !== undefined) return r.testResults.ok;
  const verdict = r.judge?.correctnessAssessment?.verdict;
  if (verdict === "likely_correct") return true;
  if (verdict === "likely_incorrect") return false;
  return undefined;
}

/** The anchor label a reliability row compares: grade, or a legacy-boolean read. */
function anchorGradeLabel(a: AnchorResult): string {
  if (a.grade !== undefined) return a.grade;
  if (a.hitKnownTrap) return "trap";
  return a.conventionHeld ? "held" : "drift";
}

/**
 * The Reliability table across --repeats groups, or the single-run sentence
 * when no cell was repeated.
 */
export function renderReliability(results: VariantTaskResult[]): string {
  const groups = aggregateReliability(results);
  if (groups.length === 0) {
    return "_single run per cell — no reliability data (use --repeats N)._";
  }
  const range = (r: { min: number; max: number } | null) =>
    r === null ? "—" : r.min === r.max ? String(r.min) : `${r.min}–${r.max}`;
  const agreement = (grades: string[]) => {
    if (grades.length === 0) return "—";
    const distinct = [...new Set(grades)];
    return distinct.length === 1
      ? `${grades.length}/${grades.length} identical`
      : distinct.join(", ");
  };
  const unknowns = (g: ReliabilityGroup) =>
    g.judgeFailures > 0
      ? `${g.craftUnknowns} (judgeFailures: ${g.judgeFailures})`
      : String(g.craftUnknowns);
  const correctness = (g: ReliabilityGroup) =>
    g.verdictRuns === 0 ? "—" : `${g.correctRuns}/${g.verdictRuns} correct`;
  const craftScore = (g: ReliabilityGroup) =>
    g.craftScore === null
      ? "—"
      : `${g.craftScore.min.toFixed(1)} / ${g.craftScore.mean.toFixed(1)} / ${g.craftScore.max.toFixed(1)}`;
  const header =
    `| Cell | Runs | Correctness | Craft score (min/mean/max) | Exec cost σ | Wall time σ | Naming | Structure | Consistency | Economy | Craft unknowns | Anchor grades |\n` +
    `| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`;
  const rows = groups.map(
    (g) =>
      `| \`${g.taskId}\` × ${g.variant} [${g.executorModel}] | ${g.runCount} | ${correctness(g)} | ${craftScore(g)} | ${g.costStddevUsd === null ? "—" : fmtCost(g.costStddevUsd)} | ${fmtSeconds(g.wallMsStddev)} | ${range(g.craftRange.naming)} | ${range(g.craftRange.structure)} | ${range(g.craftRange.consistency)} | ${range(g.craftRange.economy)} | ${unknowns(g)} | ${agreement(g.anchorGrades)} |`,
  );
  return [
    "_Dispersion across --repeats runs of the same (task × variant × model) cell — the three major axes plus per-dimension craft ranges. Correctness = agreeing runs / runs with a verdict; Craft score = per-run mean-of-dimensions as min/mean/max; σ = population standard deviation of cost/time. Executor-failed repeats are excluded (coverage gaps, not variance). Observed, never a score component._",
    "",
    [header, ...rows].join("\n"),
    "",
    "_Targeting: spend repeats on the high-variance, high-turn cells — `prisma-tx-deadlock`, `safe-redirect`, and the campaign chain — rather than uniformly across the matrix; uniform repeats mostly re-confirm the cells that were already stable. Guidance only, not enforced._",
  ].join("\n");
}

// --- Blast radius ---------------------------------------------------------------

/**
 * The Blast radius table: every file a cell touched outside its expected
 * surface, with the judge's classification. Campaign links fold in as
 * pseudo-cells identified as `<campaignId>[<linkIndex>:<taskId>] (<variant> ×
 * <model>)` — links have no cellId. Scope is computed mechanically
 * (expectedSurface globs); the judge only grades the excursions — a file it
 * didn't classify renders `unclassified`, never silently dropped. Adversarial
 * rows are the disqualifiers, so they render bold with the ☠ marker.
 */
export function renderBlastRadius(
  results: VariantTaskResult[],
  campaigns?: CampaignResult[],
): string {
  const combined = withCampaignLinks(results, campaigns);
  const declared = combined.filter((r) => r.filesOutsideExpectedSurface !== undefined);
  if (declared.length === 0) {
    return "_No cell declared an expected surface — blast radius not computed._";
  }
  const offenders = declared.filter((r) => r.filesOutsideExpectedSurface!.length > 0);
  if (offenders.length === 0) {
    return "_Every changed file stayed within its cell's expected surface._";
  }
  const header = `| Cell | File | Classification | Evidence |\n| --- | --- | --- | --- |`;
  const rows: string[] = [];
  for (const r of offenders) {
    for (const file of r.filesOutsideExpectedSurface!) {
      const entry = r.judge?.blastRadius.find((b) => b.file === file);
      const classification = entry?.classification ?? "unclassified";
      const evidence = entry ? cellText(entry.evidence) : "—";
      if (classification === "adversarial") {
        rows.push(
          `| **\`${r.cellId}\`** | **\`${file}\`** | **☠ DISQUALIFIED — adversarial** | **${evidence}** |`,
        );
      } else {
        rows.push(`| \`${r.cellId}\` | \`${file}\` | ${classification} | ${evidence} |`);
      }
    }
  }
  return [
    "_Out-of-scope files (mechanically computed from expectedSurface) with the judge's read on each excursion. Any adversarial entry disqualifies the cell from craft aggregation._",
    "",
    [header, ...rows].join("\n"),
  ].join("\n");
}

// --- Report assembly --------------------------------------------------------

/**
 * Full report markdown. Pure function of the Report payload.
 *
 * Five-axis LEXICOGRAPHIC layout — Correctness, Adherence (memory effect),
 * Craft, Efficiency, Reliability — followed by blast radius and the
 * observational sections. Axes are never combined into a weighted sum.
 */
export function renderReportMarkdown(report: Report): string {
  const meta = [
    `- **Run ID**: \`${report.runId}\``,
    `- **Task**: ${report.taskTitle} (\`${report.taskId}\`)`,
    `- **Executor model(s)**: ${report.executorModels.join(", ")}`,
    `- **Judge model (fixed)**: ${report.judgeModel}`,
    `- **Generated**: ${report.generatedAt}`,
  ];

  // ADHERENCE — deterministic anchor readouts. Each renders only when the run
  // carried the corresponding data; absent ⇒ the section is omitted entirely.
  const memoryEffectSection = hasMemoryEffect(report.results)
    ? [`## Memory effect (not scored)`, "", renderMemoryEffect(report.results), ""]
    : [];
  const campaignSection = hasCampaigns(report)
    ? [
        `## Memory effect (campaign, not scored)`,
        "",
        renderCampaignMemoryEffect(report.campaigns!),
        "",
      ]
    : [];

  return [
    `# CLAUDE.md Variant Benchmark Report`,
    "",
    meta.join("\n"),
    "",
    `## Correctness`,
    "",
    renderCorrectness(report.results, report.campaigns),
    "",
    ...memoryEffectSection,
    ...campaignSection,
    `## Craft`,
    "",
    renderCraft(report.results, report.pairwise, report.campaigns),
    "",
    `## Efficiency`,
    "",
    renderRunMetrics(report.results),
    "",
    `## Reliability`,
    "",
    renderReliability(report.results),
    "",
    `## Blast radius`,
    "",
    renderBlastRadius(report.results, report.campaigns),
    "",
    `## Excluded cells (not scored)`,
    "",
    renderExcludedCells(report.results),
    "",
    `## Behavioral signals (not scored)`,
    "",
    "_What each run actually did — sub-agent usage, tool calls, and diff shape. Observational only; these prove different CLAUDE.md variants produce genuinely different behavior, not just different scores._",
    "",
    renderBehaviorComparison(report.results),
    "",
  ].join("\n");
}

// --- Run metrics (observed — the Efficiency axis, never a score component) ----

/** Per-(variant, model) aggregated KPIs. Costs/tokens/time are SUMMED across
 * that unit's tasks (total spend); optional fields stay undefined if no run
 * reported them, so cells render `—` rather than 0. */
export interface VariantMetricsAggregate {
  variant: string;
  executorModel: string;
  wallMs: number;
  execCostUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  numTurns?: number;
  judgeCostUsd?: number;
  /** True when any member cell was disqualified (☠ marker in the table). */
  hasDisqualified: boolean;
}

/** Sum only the defined values; undefined if none were present. */
function sumOptional(values: (number | undefined)[]): number | undefined {
  const present = values.filter((v): v is number => v !== undefined);
  return present.length === 0 ? undefined : present.reduce((a, b) => a + b, 0);
}

/**
 * Aggregate metrics per (variant, model), in FIRST-SEEN group order (the same
 * mechanical ordering every five-axis aggregator uses; the retired mean-total
 * ranking no longer exists to sort by).
 */
export function aggregateMetrics(
  results: VariantTaskResult[],
): VariantMetricsAggregate[] {
  return groupByVariantModel(results).map(({ variant, executorModel, members }) => ({
    variant,
    executorModel,
    wallMs: members.reduce((a, r) => a + r.metrics.executor.wallMs, 0),
    execCostUsd: sumOptional(members.map((r) => r.metrics.executor.costUsd)),
    inputTokens: sumOptional(members.map((r) => r.metrics.executor.usage?.inputTokens)),
    outputTokens: sumOptional(members.map((r) => r.metrics.executor.usage?.outputTokens)),
    numTurns: sumOptional(members.map((r) => r.metrics.executor.numTurns)),
    judgeCostUsd: sumOptional(members.map((r) => r.metrics.judge?.costUsd)),
    hasDisqualified: members.some((r) => r.disqualified === true),
  }));
}

/** The Efficiency markdown table (with a Model column) + observed-only note. */
export function renderRunMetrics(results: VariantTaskResult[]): string {
  const header =
    `| Variant | Model | Exec time (s) | Exec cost (USD) | Input tok (uncached) | Output tok | Turns | Judge cost (USD) | Cost/task |\n` +
    `| --- | --- | --- | --- | --- | --- | --- | --- | --- |`;

  // Per-unit member cells (in task order) for the per-task cost sparkline —
  // an observational visual companion to the summed totals.
  const membersByUnit = new Map<string, VariantTaskResult[]>();
  for (const g of groupByVariantModel(results)) {
    membersByUnit.set(`${g.variant}${SEP}${g.executorModel}`, g.members);
  }

  const rows = aggregateMetrics(results).map((m) => {
    const members = membersByUnit.get(`${m.variant}${SEP}${m.executorModel}`) ?? [];
    const costs = members
      .map((r) => r.metrics.executor.costUsd)
      .filter((c): c is number => c !== undefined);
    const spark = costs.length > 0 ? sparkline(costs) : "—";
    return `| ${variantLabelWithDisqualification(m.variant, m.hasDisqualified)} | ${m.executorModel} | ${fmtSeconds(m.wallMs)} | ${fmtCost(m.execCostUsd)} | ${fmtTokens(m.inputTokens)} | ${fmtTokens(m.outputTokens)} | ${fmtInt(m.numTurns)} | ${fmtCost(m.judgeCostUsd)} | ${spark} |`;
  });

  return [
    "_Observed cost/time, summed across each (variant × model)'s task(s). Cost/task = per-task exec-cost sparkline, min/max-normalized WITHIN each unit (relative shape, not absolute magnitude). Observed only — never a score component._",
    "",
    [header, ...rows].join("\n"),
  ].join("\n");
}

// --- Behavioral signals (observed, NOT scored) ------------------------------

/** Distinct taskIds in first-seen order. */
function distinctTasks(results: VariantTaskResult[]): string[] {
  const seen: string[] = [];
  for (const r of results) if (!seen.includes(r.taskId)) seen.push(r.taskId);
  return seen;
}

/** `4 (engineer, security-reviewer)` or `0` — count plus its distinct types. */
function formatSubAgents(r: VariantTaskResult): string {
  const s = r.behavior!.subAgents;
  if (s.count === 0) return "0";
  const types = Object.keys(s.byType).join(", ");
  return types.length > 0 ? `${s.count} (${types})` : String(s.count);
}

/**
 * Per-task cross-variant behavior comparison. Groups results by taskId; each
 * task renders a table with one row per (variant [+ model when >1 model]) and
 * columns describing what the run actually did. Results with no `behavior`
 * (old report.json / excluded cells lacking a trace) render `—`. Observational
 * only — proves behavioral divergence across variants, never scored.
 */
export function renderBehaviorComparison(results: VariantTaskResult[]): string {
  const multiModel = distinctModels(results).length > 1;
  const label = (r: VariantTaskResult) =>
    multiModel ? `${r.variant}/${r.executorModel}` : r.variant;

  const header =
    `| Variant | Sub-agents | Tool calls | Files (src/test/docs) | LOC ± | Tests added | Diff hash |\n` +
    `| --- | --- | --- | --- | --- | --- | --- |`;

  const blocks = distinctTasks(results).map((taskId) => {
    const rows = results
      .filter((r) => r.taskId === taskId)
      .map((r) => {
        if (!r.behavior) {
          return `| ${label(r)} | — | — | — | — | — | — |`;
        }
        const b = r.behavior;
        const shape = `${b.changedFileShape.source}/${b.changedFileShape.test}/${b.changedFileShape.docs}`;
        const loc = `+${b.changedFileShape.linesAdded}/-${b.changedFileShape.linesRemoved}`;
        return `| ${label(r)} | ${formatSubAgents(r)} | ${b.toolCalls.total} | ${shape} | ${loc} | ${b.testCasesAdded} | \`${b.diffHash.slice(0, 8)}\` |`;
      });
    return [`### Task: \`${taskId}\``, "", [header, ...rows].join("\n")].join("\n");
  });

  return blocks.join("\n\n");
}

// --- Axis 2: Adherence — memory effect (deterministic anchors, NOT scored) ----

/**
 * Compact symbol for a graded anchor verdict. Ordered strongest-to-weakest:
 * ✓A (abstraction) > ✓L (literal) > ~I (inertia) > ~C (chain) > ✗ (drift) >
 * ⚠ (trap); ? is the fail-closed unknown.
 */
export function gradeSymbol(grade: AnchorGrade): string {
  switch (grade) {
    case "held-by-abstraction":
      return "✓A";
    case "held-by-literal":
      return "✓L";
    case "held-by-inertia":
      return "~I";
    case "held-by-chain":
      return "~C";
    case "drift":
      return "✗";
    case "trap":
      return "⚠";
    case "unknown":
      return "?";
  }
}

/** Legend for the grade symbols; rendered only when a graded verdict is present. */
const GRADE_LEGEND =
  "_Grades: ✓A = held-by-abstraction · ✓L = held-by-literal · ~I = held-by-inertia · ~C = held-by-chain · ✗ = drift · ⚠ = trap · ? = unknown._";

/**
 * Tasks whose deterministic anchor is NON-DISCRIMINATING for memory: a
 * MEMORYLESS bundle recovered the same rule from repo/task context alone, so a
 * hold here is NOT evidence of carried memory. `memory-registry` is the case
 * from issue #14 — in run `5e89e754` the `naked` bundle HELD the "register every
 * handler in registry.ts" rule (same as agentic-os), because the seed registry
 * already demonstrates the pattern. We flag it in the readout (a ✝ marker + a
 * footnote) rather than hardening the task: the rule is inherent to the fixture's
 * shape, so making it unrecoverable would mean re-designing the task mid-flight.
 * The readout section is not scored, so this only guides interpretation.
 */
const NON_DISCRIMINATING_TASKS: ReadonlySet<string> = new Set(["memory-registry"]);

/** A result carrying a deterministic anchor verdict (a sequential-memory run). */
type AnchoredResult = VariantTaskResult & { anchors: AnchorResult };

/** Sequential-memory runs only — those with an anchor verdict attached. */
function anchoredResults(results: VariantTaskResult[]): AnchoredResult[] {
  return results.filter((r): r is AnchoredResult => r.anchors !== undefined);
}

/** True when any result carries an anchor verdict — gates the whole section. */
export function hasMemoryEffect(results: VariantTaskResult[]): boolean {
  return results.some((r) => r.anchors !== undefined);
}

/**
 * Sanitize + escape judge-influenced free text for a single markdown table
 * cell — the ONE choke point every such string passes through. Newlines flatten
 * to spaces, then C0 control chars (all of them are invalid in a table cell;
 * stripping ESC also neutralizes ANSI color sequences), DEL, and the
 * zero-width set (U+200B–U+200D, U+FEFF) are stripped — they enable cosmetic
 * spoofing of what a cell appears to say. Pipes are escaped last so table
 * structure survives.
 */
export function cellText(s: string): string {
  return s
    .replace(/\r?\n/g, " ")
    .replace(/[\u0000-\u001F\u007F\u200B-\u200D\uFEFF]/g, "")
    .replace(/\|/g, "\\|")
    .trim();
}

/**
 * Compact pivot cell. GRADED verdicts render the grade symbol (turns appended
 * when known). Grade-less verdicts — legacy results and pre-graded detectors —
 * fall back to the EXACT legacy strings (`✓ held (N turns)` / `✗ broke` /
 * `✗ hit trap`), so existing renderings stay byte-identical.
 */
function anchorCell(a: AnchorResult): string {
  if (a.grade !== undefined) {
    const sym = gradeSymbol(a.grade);
    if (a.turnsToGreen === undefined) return sym;
    const unit = a.turnsToGreen === 1 ? "turn" : "turns";
    return `${sym} (${a.turnsToGreen} ${unit})`;
  }
  if (a.conventionHeld) {
    if (a.turnsToGreen === undefined) return "✓ held";
    const unit = a.turnsToGreen === 1 ? "turn" : "turns";
    return `✓ held (${a.turnsToGreen} ${unit})`;
  }
  return a.hitKnownTrap ? "✗ hit trap" : "✗ broke";
}

/**
 * MEMORY EFFECT — the Adherence readout for sequential-memory runs. Renders
 * ONLY when at least one result carries `.anchors`; otherwise the caller omits
 * the whole section so single-shot reports are unchanged.
 *
 * Leads with a per-bundle CONTRAST pivot (rows = variant, cols = task) so a
 * reader instantly sees "memory helped on task X, hurt on task Y", then a
 * per-task detail table with the verdict evidence. The anchor verdict is
 * mechanical — never folded into any score. Graded verdicts render their
 * grade symbol (with a legend); grade-less ones render the exact legacy
 * strings.
 */
export function renderMemoryEffect(results: VariantTaskResult[]): string {
  const anchored = anchoredResults(results);
  const multiModel = distinctModels(results).length > 1;
  const label = (r: VariantTaskResult) =>
    multiModel ? `${r.variant}/${r.executorModel}` : r.variant;

  const tasks = distinctTasks(anchored);
  const anyGraded = anchored.some((r) => r.anchors.grade !== undefined);

  // ✓A headline: held-by-abstraction is the strongest memory signal (the bundle
  // GENERALIZED the convention instead of re-emitting the literal). Called out
  // before the legend/grid when — and only when — it occurred. Mechanical text;
  // this section is not scored.
  const abstractionWins = anchored.filter(
    (r) => r.anchors.grade === "held-by-abstraction",
  );
  const abstractionCallout =
    abstractionWins.length === 0
      ? []
      : [
          `> **✓A held-by-abstraction:** ${abstractionWins
            .map((r) => `${label(r)} on \`${r.taskId}\``)
            .join(", ")} reused a prior abstraction rather than re-emitting the convention literal — the strongest memory signal. Mechanical, not scored.`,
          "",
        ];

  // #14: some tasks' anchors don't discriminate memory (a memoryless bundle
  // recovers the rule from context). Mark their columns and footnote the reason.
  const nonDiscriminating = tasks.filter((t) => NON_DISCRIMINATING_TASKS.has(t));
  const taskHeader = (t: string): string =>
    `\`${t}\`${NON_DISCRIMINATING_TASKS.has(t) ? " ✝" : ""}`;
  const nonDiscriminatingNote =
    nonDiscriminating.length === 0
      ? []
      : [
          `_✝ non-discriminating: a memoryless bundle also recovers this rule from repo/task context (issue #14) — a hold here is not a memory win._`,
          "",
        ];

  // Contrast pivot: one row per variant, one column per anchored task.
  const rowOrder: string[] = [];
  const byRow = new Map<string, Map<string, AnchoredResult>>();
  for (const r of anchored) {
    const key = label(r);
    if (!byRow.has(key)) {
      byRow.set(key, new Map());
      rowOrder.push(key);
    }
    byRow.get(key)!.set(r.taskId, r);
  }

  const pivotHeader =
    `| Variant | ${tasks.map((t) => taskHeader(t)).join(" | ")} |\n` +
    `| --- | ${tasks.map(() => "---").join(" | ")} |`;
  const pivotRows = rowOrder.map((row) => {
    const cells = tasks.map((t) => {
      const r = byRow.get(row)!.get(t);
      return r ? anchorCell(r.anchors) : "—";
    });
    return `| ${row} | ${cells.join(" | ")} |`;
  });
  const pivot = [pivotHeader, ...pivotRows].join("\n");

  // Per-task detail: the verdict evidence, one table per task.
  const detailHeader =
    `| Variant | Convention held | Turns to green | Hit known trap | Evidence |\n` +
    `| --- | --- | --- | --- | --- |`;
  const details = tasks.map((t) => {
    const rows = anchored
      .filter((r) => r.taskId === t)
      .map((r) => {
        const a = r.anchors;
        const held =
          a.grade !== undefined ? gradeSymbol(a.grade) : a.conventionHeld ? "✓" : "✗";
        const turns = a.turnsToGreen !== undefined ? String(a.turnsToGreen) : "—";
        const trap = a.hitKnownTrap ? "⚠️ yes" : "no";
        return `| ${label(r)} | ${held} | ${turns} | ${trap} | ${cellText(a.evidence)} |`;
      });
    return [`### Task: \`${t}\``, "", [detailHeader, ...rows].join("\n")].join("\n");
  });

  return [
    "_Deterministic readout: did each bundle hold the required convention across a context reset? Anchors are mechanical (not the judge)._",
    "",
    ...abstractionCallout,
    ...(anyGraded ? [GRADE_LEGEND, ""] : []),
    "#### Contrast — memory helped vs hurt (per bundle)",
    "",
    "_✓ held = kept the required convention; ✗ hit trap = adopted the known wrong convention._",
    "",
    ...nonDiscriminatingNote,
    pivot,
    "",
    ...details,
  ].join("\n");
}

/** Structured MEMORY EFFECT block for report.json, or undefined when no anchors. */
export function buildMemoryEffect(
  results: VariantTaskResult[],
):
  | {
      tasks: string[];
      cells: Array<{
        variant: string;
        executorModel: string;
        taskId: string;
        conventionHeld: boolean;
        turnsToGreen: number | null;
        hitKnownTrap: boolean;
        evidence: string;
        scored: boolean;
      }>;
    }
  | undefined {
  const anchored = anchoredResults(results);
  if (anchored.length === 0) return undefined;
  return {
    tasks: distinctTasks(anchored),
    cells: anchored.map((r) => ({
      variant: r.variant,
      executorModel: r.executorModel,
      taskId: r.taskId,
      conventionHeld: r.anchors.conventionHeld,
      turnsToGreen: r.anchors.turnsToGreen ?? null,
      hitKnownTrap: r.anchors.hitKnownTrap,
      evidence: r.anchors.evidence,
      scored: isScored(r),
    })),
  };
}

// --- Adherence — memory effect (campaign trajectory, NOT scored) --------------

/** True when the report carries at least one campaign trajectory. */
export function hasCampaigns(report: Report): boolean {
  return Array.isArray(report.campaigns) && report.campaigns.length > 0;
}

/** Anchored links (those with an anchor verdict) and how many held the convention. */
export function campaignAdherence(c: CampaignResult): {
  adhered: number;
  anchored: number;
} {
  const anchored = c.tasks.filter((t) => t.anchors !== undefined);
  const adhered = anchored.filter((t) => t.anchors!.conventionHeld).length;
  return { adhered, anchored: anchored.length };
}

/**
 * Partition a campaign's anchored links into cumulative failure/hold modes
 * (issue #15): `held` (kept the convention), `trap` (adopted the known-wrong
 * convention), `unknown` (fail-closed — the detector could NOT observe the link,
 * e.g. an empty/ungradable diff), and `drift` (broke it some OTHER way —
 * everything anchored that is none of the above). The buckets are mutually
 * exclusive and sum to `anchored`. `unknown` is split OUT of `drift` on purpose:
 * drift must mean strictly "the bundle wrote something else and got it wrong",
 * not "we couldn't tell". Distinguishing drift from trap matters because they
 * are different diagnoses at different costs — a drift burned turns to still be
 * wrong, a trap blindly re-applied a stale memory. The plain `1/3 vs 0/3`
 * cumulative line collapsed all of these.
 */
export function campaignAdherenceBreakdown(c: CampaignResult): {
  held: number;
  drift: number;
  trap: number;
  unknown: number;
  anchored: number;
} {
  const anchored = c.tasks.filter((t) => t.anchors !== undefined);
  const held = anchored.filter((t) => t.anchors!.conventionHeld).length;
  const trap = anchored.filter((t) => !t.anchors!.conventionHeld && t.anchors!.hitKnownTrap).length;
  const unknown = anchored.filter((t) => t.anchors!.grade === "unknown").length;
  const drift = anchored.length - held - trap - unknown;
  return { held, drift, trap, unknown, anchored: anchored.length };
}

/** Distinct executor models across campaigns, first-seen order. */
function distinctCampaignModels(campaigns: CampaignResult[]): string[] {
  const seen: string[] = [];
  for (const c of campaigns) {
    if (!seen.includes(c.executorModel)) seen.push(c.executorModel);
  }
  return seen;
}

/** Union of campaign links keyed by chain index (first-seen id), sorted by index. */
function campaignTaskOrder(
  campaigns: CampaignResult[],
): { index: number; taskId: string }[] {
  const byIndex = new Map<number, string>();
  for (const c of campaigns) {
    for (const t of c.tasks) {
      if (!byIndex.has(t.index)) byIndex.set(t.index, t.taskId);
    }
  }
  return [...byIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, taskId]) => ({ index, taskId }));
}

/**
 * Adherence sub-cell. GRADED verdicts render the grade symbol; grade-less
 * verdicts fall back to the EXACT legacy strings: — (no anchor), ✓ held,
 * ✗ drift, or ✗ drift ⚠ trap.
 */
function campaignAdherenceCell(t: CampaignTaskResult): string {
  if (!t.anchors) return "—";
  if (t.anchors.grade !== undefined) return gradeSymbol(t.anchors.grade);
  if (t.anchors.conventionHeld) return "✓ held";
  return t.anchors.hitKnownTrap ? "✗ drift ⚠ trap" : "✗ drift";
}

/**
 * Absolute adherence strength of an anchor verdict on a fixed `0..6` scale, for
 * the trajectory sparkline: held-by-abstraction (6) → held-by-literal (4) →
 * held-by-inertia (3) → held-by-chain (2) → drift (1) → trap/unknown (0). Mirrors
 * the AnchorGrade strength ordering (unknown fails closed to the floor).
 * Grade-less legacy anchors read from the booleans: a hold ≈ held-by-literal (4),
 * a trap → 0, other breakage → drift (1).
 */
const ADHERENCE_MAX_LEVEL = 6;
function anchorAdherenceLevel(a: AnchorResult): number {
  if (a.grade !== undefined) {
    switch (a.grade) {
      case "held-by-abstraction":
        return 6;
      case "held-by-literal":
        return 4;
      case "held-by-inertia":
        return 3;
      case "held-by-chain":
        return 2;
      case "drift":
        return 1;
      case "trap":
      case "unknown":
        return 0;
    }
  }
  if (a.conventionHeld) return 4;
  return a.hitKnownTrap ? 0 : 1;
}

/**
 * One trajectory cell: adherence LEADS, then executor turns as secondary
 * context, with a `✗fail` marker between them when the link failed. A missing
 * link renders `—`. A failed link keeps its adherence — the deterministic
 * anchor still stands when the executor succeeded (a judge-only failure), so
 * adherence is shown regardless, keeping this cell consistent with the
 * cumulative-adherence headline (which counts the anchor). When the executor
 * itself failed, no anchor was computed and adherence is `—`. A disqualified
 * (adversarial) link gets ☠ appended to its adherence symbol so the
 * disqualification is visible in the trajectory, not just in report.json.
 * Missing turns degrade to `—`, never `undefined`/`NaN`.
 */
function campaignCell(t: CampaignTaskResult | undefined): string {
  if (!t) return "—";
  const adherence =
    campaignAdherenceCell(t) + (t.disqualified === true ? " ☠" : "");
  const turns = t.metrics.numTurns !== undefined ? `${t.metrics.numTurns}t` : "—";
  return [adherence, ...(t.failure ? ["✗fail"] : []), turns].join(" · ");
}

/**
 * CAMPAIGN MEMORY EFFECT — the longitudinal Adherence readout. Leads with the
 * cumulative adherence delta (memory bundle vs memoryless), then a per-task
 * trajectory where anchors lead and score/turns are secondary. Anchors are
 * mechanical — never folded into any score. Renders only when campaigns are
 * present. Graded links render their grade symbol (with a legend); grade-less
 * links render the exact legacy strings.
 */
export function renderCampaignMemoryEffect(campaigns: CampaignResult[]): string {
  const multiModel = distinctCampaignModels(campaigns).length > 1;
  const label = (c: CampaignResult) =>
    cellText(multiModel ? `${c.variant}/${c.executorModel}` : c.variant);
  const anyGraded = campaigns.some((c) =>
    c.tasks.some((t) => t.anchors?.grade !== undefined),
  );

  // Headline cumulative adherence delta — the memory-vs-memoryless contrast.
  // Keeps the `adhered/anchored` fraction, then breaks the rest into drift vs
  // trap (issue #15) so the summary never collapses "wrote something else" and
  // "adopted the known-wrong convention" into one number.
  const headline = campaigns
    .map((c, i) => {
      const { held, drift, trap, unknown, anchored } = campaignAdherenceBreakdown(c);
      const suffix = i === 0 ? " adhered" : "";
      const unknownNote = unknown > 0 ? ` · ${unknown} unknown` : "";
      return `${label(c)} ${held}/${anchored}${suffix} (${held} held · ${drift} drift · ${trap} trap${unknownNote})`;
    })
    .join(" | ");

  // Trajectory: rows = chain link (index/id), columns = bundle.
  const tasks = campaignTaskOrder(campaigns);
  const header =
    `| Task | ${campaigns.map(label).join(" | ")} |\n` +
    `| --- | ${campaigns.map(() => "---").join(" | ")} |`;
  const rows = tasks.map(({ index, taskId }) => {
    const cells = campaigns.map((c) =>
      campaignCell(c.tasks.find((t) => t.index === index)),
    );
    return `| #${index} \`${cellText(taskId)}\` | ${cells.join(" | ")} |`;
  });
  const table = [header, ...rows].join("\n");

  // Per-bundle adherence sparkline across the chain (anchored links only, in
  // index order). Absolute scale: an all-abstraction chain reads tall, an
  // all-trap chain reads flat. Purely observational — a visual companion to the
  // grade cells below, changing no number.
  const sparkLines = campaigns.map((c) => {
    const levels = [...c.tasks]
      .filter((t) => t.anchors !== undefined)
      .sort((a, b) => a.index - b.index)
      .map((t) => anchorAdherenceLevel(t.anchors!));
    const spark = levels.length > 0 ? levelSparkline(levels, ADHERENCE_MAX_LEVEL) : "—";
    return `- ${label(c)} \`${spark}\``;
  });

  return [
    `**Cumulative adherence:** ${headline}`,
    "",
    "_Anchored links whose required convention held, per bundle — a memory bundle should stay consistent across the chain while a memoryless one drifts. Anchors are mechanical (not the judge)._",
    "",
    ...(anyGraded ? [GRADE_LEGEND, ""] : []),
    "#### Per-task trajectory",
    "",
    "_Adherence sparkline per bundle across the chain (higher = stronger hold: trap/drift low → held-by-literal mid → held-by-abstraction high). Observational only._",
    "",
    ...sparkLines,
    "",
    "_Cell = adherence · executor turns. ✓ held = kept the convention; ✗ drift = broke it; ⚠ trap = adopted the known-wrong convention; — = no anchor (judged only); ✗fail = link failed; ☠ = disqualified (adversarial)._",
    "",
    table,
  ].join("\n");
}

/** Structured CAMPAIGN memory-effect block for report.json, or undefined when empty. */
export function buildCampaignMemoryEffect(
  campaigns: CampaignResult[],
):
  | {
      bundles: Array<{
        variant: string;
        executorModel: string;
        campaignId: string;
        adheredCount: number;
        anchoredCount: number;
        tasks: Array<{
          index: number;
          taskId: string;
          conventionHeld: boolean | null;
          hitKnownTrap: boolean;
          turns: number | null;
          failure?: string;
        }>;
      }>;
    }
  | undefined {
  if (campaigns.length === 0) return undefined;
  return {
    bundles: campaigns.map((c) => {
      const { adhered, anchored } = campaignAdherence(c);
      return {
        variant: c.variant,
        executorModel: c.executorModel,
        campaignId: c.campaignId,
        adheredCount: adhered,
        anchoredCount: anchored,
        tasks: c.tasks.map((t) => ({
          index: t.index,
          taskId: t.taskId,
          conventionHeld: t.anchors ? t.anchors.conventionHeld : null,
          hitKnownTrap: t.anchors ? t.anchors.hitKnownTrap : false,
          turns: t.metrics.numTurns ?? null,
          ...(t.failure ? { failure: t.failure } : {}),
        })),
      };
    }),
  };
}

// --- I/O --------------------------------------------------------------------

/**
 * Build the serialized report.json payload: each result carried VERBATIM
 * (including the five-axis fields — judge, slop, testResults,
 * filesOutsideExpectedSurface, disqualified, repeat — when present; legacy
 * results simply omit them) and stamped with `scored`/`excludedReason`
 * (derived, so regenerate recomputes it). `pairwise` rides along verbatim via
 * the Report spread. The per-(variant × model) summary carries coverage COUNTS
 * only — never mean scores.
 */
export function buildReportJson(report: Report): unknown {
  const results = report.results.map((r) => ({
    ...r,
    scored: isScored(r),
    ...(isScored(r) ? {} : { excludedReason: excludedReasonOf(r) }),
  }));
  const variantSummary = groupByVariantModel(report.results).map(
    ({ variant, executorModel, members }) => ({
      variant,
      executorModel,
      scoredCount: members.filter(isScored).length,
      attemptedCount: members.length,
    }),
  );
  const memoryEffect = buildMemoryEffect(report.results);
  const memoryEffectCampaign = hasCampaigns(report)
    ? buildCampaignMemoryEffect(report.campaigns!)
    : undefined;
  return {
    ...report,
    variantSummary,
    results,
    ...(memoryEffect ? { memoryEffect } : {}),
    ...(memoryEffectCampaign ? { memoryEffectCampaign } : {}),
  };
}

/** Write report.json and report.md into the run's own folder (`outDir`). */
export async function writeReport(
  report: Report,
  outDir: string,
): Promise<{ jsonPath: string; mdPath: string }> {
  await fs.mkdir(outDir, { recursive: true });
  const jsonPath = path.join(outDir, "report.json");
  const mdPath = path.join(outDir, "report.md");
  await fs.writeFile(jsonPath, JSON.stringify(buildReportJson(report), null, 2));
  await fs.writeFile(mdPath, renderReportMarkdown(report));
  return { jsonPath, mdPath };
}

/**
 * Regenerate report.md + report.json from a FINISHED run, offline. `target` is
 * a run folder (containing report.json) or a report.json file directly. Loads
 * saved results, re-runs the current aggregation + rendering, and rewrites both
 * files in place. No Docker, no auth, no executor/judge calls.
 */
export async function regenerateReport(
  target: string,
): Promise<{ jsonPath: string; mdPath: string }> {
  const stat = await fs.stat(target).catch(() => null);
  const jsonPath =
    stat?.isDirectory() ? path.join(target, "report.json") : target;
  const outDir = path.dirname(jsonPath);

  const raw = await fs.readFile(jsonPath, "utf8");
  const report = JSON.parse(raw) as Report;
  if (!Array.isArray(report.results)) {
    throw new Error(`${jsonPath} is not a valid report.json (missing results[]).`);
  }
  return writeReport(report, outDir);
}
