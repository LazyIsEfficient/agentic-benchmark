import assert from "node:assert/strict";
import { test } from "node:test";
import { applyCapsAndScore } from "./rubric.js";
import type { JudgeResult } from "./types.js";

type Scores = Partial<{
  codeQuality: number;
  testingCoverage: number;
  securityQuality: number;
  documentation: number;
}>;

function judge(scores: Scores = {}, securityReviewPerformed = true): JudgeResult {
  const j = (score: number) => ({ score, justification: "j" });
  return {
    codeQuality: j(scores.codeQuality ?? 25),
    testingCoverage: j(scores.testingCoverage ?? 35),
    securityQuality: j(scores.securityQuality ?? 18),
    documentation: j(scores.documentation ?? 8),
    securityReviewPerformed,
    summary: "s",
  };
}

/**
 * Build the signals object for applyCapsAndScore with cap-neutral defaults, so
 * each test overrides only the signals it exercises. taskSolved defaults to true
 * (the punitive cap only fires on an explicit false).
 */
function sig(
  overrides: Partial<Parameters<typeof applyCapsAndScore>[1]> = {},
): Parameters<typeof applyCapsAndScore>[1] {
  return {
    logicBearing: false,
    securityRelevant: false,
    testFilesPresent: false,
    correctnessGated: false,
    taskSolved: true,
    ...overrides,
  };
}

test("no caps fire when signals are satisfied", () => {
  const { final, total, appliedCaps } = applyCapsAndScore(
    judge(),
    sig({ logicBearing: true, securityRelevant: true, testFilesPresent: true }),
  );
  assert.equal(appliedCaps.length, 0);
  assert.deepEqual(final, {
    codeQuality: 25,
    testingCoverage: 35,
    securityQuality: 18,
    documentation: 8,
  });
  assert.equal(total, 86);
});

// --- Testing cap: MECHANICAL (unchanged) ------------------------------------

test("testing cap fires: logic-bearing task with no test files clamps to 10", () => {
  const { final, total, appliedCaps } = applyCapsAndScore(
    judge({ testingCoverage: 38 }),
    sig({ logicBearing: true }),
  );
  assert.equal(final.testingCoverage, 10);
  assert.equal(total, 25 + 10 + 18 + 8);
  const cap = appliedCaps.find((c) => c.dimension === "testingCoverage");
  assert.ok(cap);
  assert.equal(cap?.rawScore, 38);
  assert.equal(cap?.cappedTo, 10);
});

test("testing cap does NOT fire when task is not logic-bearing", () => {
  const { final, appliedCaps } = applyCapsAndScore(
    judge({ testingCoverage: 38 }),
    sig({ logicBearing: false }),
  );
  assert.equal(final.testingCoverage, 38);
  assert.equal(appliedCaps.length, 0);
});

test("testing cap does NOT fire when tests are present even below cap", () => {
  const { final, appliedCaps } = applyCapsAndScore(
    judge({ testingCoverage: 9 }),
    sig({ logicBearing: true, testFilesPresent: true }),
  );
  assert.equal(final.testingCoverage, 9);
  assert.equal(appliedCaps.length, 0);
});

// --- Security cap: driven by the JUDGE's securityReviewPerformed ------------

test("security cap fires: securityRelevant + judge says no review → clamps to 8", () => {
  const { final, appliedCaps } = applyCapsAndScore(
    judge({ securityQuality: 19 }, false),
    sig({ securityRelevant: true, testFilesPresent: true }),
  );
  assert.equal(final.securityQuality, 8);
  const cap = appliedCaps.find((c) => c.dimension === "securityQuality");
  assert.equal(cap?.rawScore, 19);
  assert.equal(cap?.cappedTo, 8);
  assert.match(cap!.reason, /judge found no visible security review/);
});

test("security cap does NOT fire when the judge says a review WAS performed", () => {
  const { final, appliedCaps } = applyCapsAndScore(
    judge({ securityQuality: 19 }, true),
    sig({ securityRelevant: true, testFilesPresent: true }),
  );
  assert.equal(final.securityQuality, 19);
  assert.equal(appliedCaps.length, 0);
});

test("security cap does NOT fire on a non-security-relevant task regardless", () => {
  const { final, appliedCaps } = applyCapsAndScore(
    judge({ securityQuality: 19 }, false),
    sig({ securityRelevant: false, testFilesPresent: true }),
  );
  assert.equal(final.securityQuality, 19);
  assert.equal(appliedCaps.length, 0);
});

test("security cap does not fire when score already at/below ceiling", () => {
  const { final, appliedCaps } = applyCapsAndScore(
    judge({ securityQuality: 8 }, false),
    sig({ securityRelevant: true, testFilesPresent: true }),
  );
  assert.equal(final.securityQuality, 8);
  assert.equal(appliedCaps.length, 0);
});

test("both caps can fire together and totals sum post-cap", () => {
  const { final, total, appliedCaps } = applyCapsAndScore(
    judge({ codeQuality: 20, testingCoverage: 40, securityQuality: 20, documentation: 5 }, false),
    sig({ logicBearing: true, securityRelevant: true }),
  );
  assert.equal(final.testingCoverage, 10);
  assert.equal(final.securityQuality, 8);
  assert.equal(total, 20 + 10 + 8 + 5);
  assert.equal(appliedCaps.length, 2);
});

// --- Correctness cap: driven by the JUDGE's taskSolved (TOTAL clamp) ---------

test("correctness cap fires: gated + taskSolved=false clamps the TOTAL to 30", () => {
  // Dimensions sum to 86; the per-dimension finals stay untouched, only the
  // headline total is clamped.
  const { final, total, appliedCaps } = applyCapsAndScore(
    judge(),
    sig({ correctnessGated: true, taskSolved: false }),
  );
  assert.equal(total, 30);
  assert.deepEqual(final, {
    codeQuality: 25,
    testingCoverage: 35,
    securityQuality: 18,
    documentation: 8,
  });
  const cap = appliedCaps.find((c) => c.dimension === "total");
  assert.ok(cap);
  assert.equal(cap?.rawScore, 86);
  assert.equal(cap?.cappedTo, 30);
  assert.match(cap!.reason, /taskSolved=false/);
});

test("correctness cap does NOT fire when the judge says taskSolved=true", () => {
  const { total, appliedCaps } = applyCapsAndScore(
    judge(),
    sig({ correctnessGated: true, taskSolved: true }),
  );
  assert.equal(total, 86);
  assert.equal(appliedCaps.find((c) => c.dimension === "total"), undefined);
});

test("correctness cap does NOT fire on a non-gated task even when taskSolved=false", () => {
  // Backward-compat: an unsolved signal is inert unless the task is gated.
  const { total, appliedCaps } = applyCapsAndScore(
    judge(),
    sig({ correctnessGated: false, taskSolved: false }),
  );
  assert.equal(total, 86);
  assert.equal(appliedCaps.length, 0);
});

test("correctness cap does NOT record a cap when total already at/below the ceiling", () => {
  // Sum = 5+10+3+2 = 20 ≤ 30, so clamping to 30 would be an inflation — skip it.
  const { total, appliedCaps } = applyCapsAndScore(
    judge({ codeQuality: 5, testingCoverage: 10, securityQuality: 3, documentation: 2 }),
    sig({ correctnessGated: true, taskSolved: false }),
  );
  assert.equal(total, 20);
  assert.equal(appliedCaps.find((c) => c.dimension === "total"), undefined);
});
