import {
  CORRECTNESS_CAP_WHEN_UNSOLVED,
  DIMENSION_MAX,
  JUDGE_MODEL,
  SECURITY_CAP_WHEN_NO_REVIEW,
  TESTING_CAP_WHEN_NO_TESTS,
} from "./config.js";
import type {
  AppliedCap,
  JudgeResult,
  RunArtifacts,
  TaskMeta,
  VariantTaskResult,
} from "./types.js";

/**
 * The evaluation rubric, copied VERBATIM from prompt.md. This exact text is
 * embedded in the judge prompt so the judge scores against the same bar the
 * spec defines. Do not paraphrase — the wording (point bands, critical caps)
 * is load-bearing.
 */
export const RUBRIC_TEXT = `You are a strict, senior-level code reviewer acting as a combined Staff Engineer + QA Lead + Security Engineer + Tech Writer. Score the agent's output on the following four dimensions. Be harsh but fair. Base your scores only on evidence visible in the final state (files created/modified, test files, docs, and any explicit review steps the agent took).

### 1. Code Quality (0–30 points)
**Focus:** Architecture, maintainability, readability, and adherence to good engineering principles.

- **25–30 pts**: Excellent. Strong use of SOLID principles, clear separation of concerns, minimal duplication, excellent naming, highly readable. Code looks like it was written by a thoughtful senior engineer.
- **18–24 pts**: Good. Generally clean and readable with only minor issues (some long functions, slight duplication, or one area that could be better abstracted).
- **10–17 pts**: Acceptable but flawed. Works but has noticeable problems with structure, readability, or unnecessary complexity.
- **0–9 pts**: Poor. Hard to follow, significant duplication, poor abstractions, or violates basic maintainability principles.

**Deduct points for**: God classes, deep nesting, magic numbers/strings without explanation, inconsistent patterns, premature optimization that hurts clarity.

### 2. Testing Coverage (0–40 points) — Heaviest weighted dimension
**Focus:** Whether a proper testing framework was used and whether tests are actually valuable.

- **35–40 pts**: Outstanding. Appropriate testing framework is present. Tests cover happy path + important edge cases/error conditions. Tests are well-organized and would catch real regressions.
- **25–34 pts**: Solid. Testing framework is used and core functionality is tested. Some edge cases may be missing but the intent is clearly there.
- **15–24 pts**: Weak. Some tests exist but they are shallow (mostly happy path), use the wrong framework for the language, or feel like they were added just to check a box.
- **0–14 pts**: Inadequate or missing. No real tests, or tests are trivial/non-existent despite the task clearly requiring them.

**Critical rule**: If the task involves writing logic or modifying behavior and **no test framework/files** were created or updated, the maximum score for this dimension is 10.

### 3. Security Quality (0–20 points)
**Focus:** Whether a security review was performed and whether obvious issues were introduced or left unaddressed.

- **16–20 pts**: Strong. The agent explicitly considered security (visible in thinking or review steps). No high or critical issues found. Secure defaults and proper input handling are present where relevant.
- **10–15 pts**: Acceptable. No major security problems introduced. Some minor concerns may exist but nothing that would be considered a real vulnerability in most contexts.
- **5–9 pts**: Concerning. At least one notable security smell or missed validation. No evidence that a real security review was performed.
- **0–4 pts**: Dangerous. Clear security issues introduced (injection risks, missing authz, secrets in code, unsafe deserialization, etc.) **or** the agent skipped any security consideration on security-relevant work.

**Important**: If the task has security implications and the agent did **not** perform any visible security review step, cap this dimension at 8 points maximum.

### 4. Documentation (0–10 points)
**Focus:** Whether relevant documentation was created or meaningfully updated.

- **8–10 pts**: Excellent. Documentation (README updates, inline docs, architecture notes, API docs, etc.) was created or updated in a useful way as part of the work.
- **5–7 pts**: Decent. Some documentation exists or was lightly updated.
- **0–4 pts**: Poor or missing. No meaningful documentation work was done even when it was clearly warranted by the task.`;

/**
 * The human-facing scores format, VERBATIM from prompt.md. The report renders
 * the judge's structured output back into this exact markdown shape; it is not
 * sent to the judge (the judge is asked for a strict JSON block — see
 * buildJudgePrompt).
 */
export const JUDGE_OUTPUT_FORMAT = `## Scores

- **Code Quality**: X/30 — [1-2 sentence justification with specific evidence]
- **Testing Coverage**: X/40 — [1-2 sentence justification with specific evidence]
- **Security Quality**: X/20 — [1-2 sentence justification with specific evidence]
- **Documentation**: X/10 — [1-2 sentence justification with specific evidence]

**Total Score: XX/100**

## Summary
[2-4 sentence overall assessment of how well this variant performed relative to a high engineering bar]`;

/**
 * Build the full judge prompt. Embeds the verbatim rubric, a strict JSON output
 * contract, the task description, and the evidence bundle. The judge runs with no
 * tools and NO CLI-side schema enforcement (that caused repeated structured-
 * output retry failures on Opus), so the prompt itself must fully specify the
 * output shape. The harness parses the JSON block from the response and applies
 * deterministic validation as the trust backstop.
 */
export function buildJudgePrompt(args: {
  taskTitle: string;
  taskPrompt: string;
  diff: string;
  fileSummary: string;
  transcript: string;
  /**
   * When set, the task is correctness-gated: the judge is told the success
   * criteria and instructed to additionally return a boolean `taskSolved`. The
   * extra text is built conditionally so a non-gated prompt is byte-identical to
   * the base template.
   */
  successCriteria?: string;
}): string {
  // Conditional additions for correctness-gated tasks. Each is "" when the task
  // is not gated, keeping the emitted prompt byte-identical to today's.
  const taskSolvedKeyBullet = args.successCriteria
    ? `
- "taskSolved": boolean — set to true ONLY if the evidence shows the change
  satisfies the task-specific success criteria below; false otherwise. This
  drives the rubric's correctness cap, so set it accurately.`
    : "";
  const taskSolvedExampleLine = args.successCriteria
    ? `
  "taskSolved": true,`
    : "";
  const successCriteriaBlock = args.successCriteria
    ? `## Task-specific success criteria
${args.successCriteria}

You MUST additionally return a boolean \`taskSolved\` key in your JSON output —
set it to true ONLY if the evidence shows the change satisfies the criteria
above, and false otherwise.

`
    : "";

  return `${RUBRIC_TEXT}

## Required output format (STRICT)
Respond with ONLY a single JSON object inside one \`\`\`json fenced code block.
No prose, explanation, or markdown before or after the block. The object must
have EXACTLY these six keys and nothing else:

- "codeQuality": { "score": integer 0-${DIMENSION_MAX.codeQuality}, "justification": string }
- "testingCoverage": { "score": integer 0-${DIMENSION_MAX.testingCoverage}, "justification": string }
- "securityQuality": { "score": integer 0-${DIMENSION_MAX.securityQuality}, "justification": string }
- "documentation": { "score": integer 0-${DIMENSION_MAX.documentation}, "justification": string }
- "securityReviewPerformed": boolean — set to true if the evidence shows the agent
  performed a visible security review / threat modeling / deliberate security
  consideration of this change; false if security was not visibly considered.
  This drives the rubric's security cap, so set it accurately.${taskSolvedKeyBullet}
- "summary": string (2-4 sentence overall assessment)

Each "justification" is 1-2 sentences citing specific evidence. Do NOT include a
total — the harness computes it. Output exactly this shape (values below are
illustrative only):

\`\`\`json
{
  "codeQuality": { "score": 24, "justification": "..." },
  "testingCoverage": { "score": 30, "justification": "..." },
  "securityQuality": { "score": 15, "justification": "..." },
  "documentation": { "score": 7, "justification": "..." },
  "securityReviewPerformed": true,${taskSolvedExampleLine}
  "summary": "..."
}
\`\`\`

${successCriteriaBlock}---

# EVIDENCE TO EVALUATE

## Task given to the agent
Title: ${args.taskTitle}

${args.taskPrompt}

## Changed files (classification)
${args.fileSummary}

## Unified diff of the agent's work
\`\`\`diff
${args.diff || "(no changes were made)"}
\`\`\`

## Agent transcript (assistant messages + tool usage)
${args.transcript || "(no transcript captured)"}
`;
}

/**
 * Enforce the two deterministic rubric caps AFTER parsing the judge's scores.
 * These are backstops: the judge is instructed on the caps too, but the harness
 * must not trust the judge to apply them. Returns final per-dimension scores,
 * the computed total, and a record of any cap that fired.
 *
 * Pure function — no I/O — so it is directly unit-testable.
 */
export function applyCapsAndScore(
  raw: JudgeResult,
  signals: {
    logicBearing: boolean;
    securityRelevant: boolean;
    testFilesPresent: boolean;
    correctnessGated: boolean;
    taskSolved: boolean;
  },
): Pick<VariantTaskResult, "final" | "total" | "appliedCaps"> {
  const appliedCaps: AppliedCap[] = [];

  // Testing cap: MECHANICAL — a *.test.* file exists or it doesn't.
  let testingCoverage = raw.testingCoverage.score;
  if (
    signals.logicBearing &&
    !signals.testFilesPresent &&
    testingCoverage > TESTING_CAP_WHEN_NO_TESTS
  ) {
    appliedCaps.push({
      dimension: "testingCoverage",
      rawScore: testingCoverage,
      cappedTo: TESTING_CAP_WHEN_NO_TESTS,
      reason: `Logic-bearing task but no test files were created/updated; capped at ${TESTING_CAP_WHEN_NO_TESTS} per rubric.`,
    });
    testingCoverage = TESTING_CAP_WHEN_NO_TESTS;
  }

  // Security cap: driven by the JUDGE's own determination. "Was a security
  // review performed" is a semantic judgment, not mechanically checkable — a
  // keyword scan false-negatived and contradicted the judge's justification.
  let securityQuality = raw.securityQuality.score;
  if (
    signals.securityRelevant &&
    raw.securityReviewPerformed === false &&
    securityQuality > SECURITY_CAP_WHEN_NO_REVIEW
  ) {
    appliedCaps.push({
      dimension: "securityQuality",
      rawScore: securityQuality,
      cappedTo: SECURITY_CAP_WHEN_NO_REVIEW,
      reason: `Security-relevant task and the judge found no visible security review step; capped at ${SECURITY_CAP_WHEN_NO_REVIEW} per rubric.`,
    });
    securityQuality = SECURITY_CAP_WHEN_NO_REVIEW;
  }

  const final = {
    codeQuality: raw.codeQuality.score,
    testingCoverage,
    securityQuality,
    documentation: raw.documentation.score,
  };

  let total =
    final.codeQuality +
    final.testingCoverage +
    final.securityQuality +
    final.documentation;

  // Correctness cap: driven by the JUDGE's own taskSolved determination. Unlike
  // the per-dimension caps this clamps the headline TOTAL — a correctness-gated
  // task whose core requirement went unmet must not score well regardless of how
  // clean the incidental code was. The per-dimension `final` values are left
  // UNCHANGED so the report still shows the quality of what was written.
  if (
    signals.correctnessGated &&
    signals.taskSolved === false &&
    total > CORRECTNESS_CAP_WHEN_UNSOLVED
  ) {
    appliedCaps.push({
      dimension: "total",
      rawScore: total,
      cappedTo: CORRECTNESS_CAP_WHEN_UNSOLVED,
      reason: `Correctness-gated task; judge found the core requirement unmet (taskSolved=false); total capped at ${CORRECTNESS_CAP_WHEN_UNSOLVED}.`,
    });
    total = CORRECTNESS_CAP_WHEN_UNSOLVED;
  }

  return { final, total, appliedCaps };
}

/**
 * Assemble the final VariantTaskResult from a judge result + run artifacts +
 * task meta. Pure composition of applyCapsAndScore with the surrounding
 * bookkeeping so callers get one typed object.
 */
export function scoreRun(
  raw: JudgeResult,
  artifacts: RunArtifacts,
  meta: TaskMeta,
): VariantTaskResult {
  // Default taskSolved to true so the punitive total cap only fires on an
  // explicit false — same philosophy as securityReviewPerformed.
  const correctnessGated = !!meta.successCriteria;
  const { final, total, appliedCaps } = applyCapsAndScore(raw, {
    logicBearing: meta.logicBearing,
    securityRelevant: meta.securityRelevant,
    testFilesPresent: artifacts.testFilesPresent,
    correctnessGated,
    taskSolved: raw.taskSolved ?? true,
  });

  return {
    cellId: artifacts.cellId,
    variant: artifacts.variant,
    taskId: artifacts.taskId,
    executorModel: artifacts.executorModel,
    judgeModel: JUDGE_MODEL,
    raw,
    final,
    total,
    appliedCaps,
    signals: {
      testFilesPresent: artifacts.testFilesPresent,
      securityReviewPerformed: raw.securityReviewPerformed,
      taskSolved: correctnessGated ? (raw.taskSolved ?? true) : undefined,
      changedFiles: artifacts.changedFiles,
    },
    // Executor metrics are always available; the judge's are attached by judgeRun.
    metrics: { executor: artifacts.executorMetrics },
    ...(artifacts.behavior ? { behavior: artifacts.behavior } : {}),
  };
}
