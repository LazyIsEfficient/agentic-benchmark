import assert from "node:assert/strict";
import { test } from "node:test";
import { extractJudgeJson, parseJudgeResult, truncateEvidence } from "./judge.js";
import { buildJudgePrompt } from "./rubric.js";

const validPayload = {
  codeQuality: { score: 25, justification: "clean" },
  testingCoverage: { score: 35, justification: "thorough" },
  securityQuality: { score: 18, justification: "reviewed" },
  documentation: { score: 8, justification: "documented" },
  securityReviewPerformed: true,
  summary: "great",
};

test("parseJudgeResult accepts a well-formed payload", () => {
  const r = parseJudgeResult(validPayload);
  assert.equal(r.codeQuality.score, 25);
  assert.equal(r.summary, "great");
  assert.equal(r.securityReviewPerformed, true);
});

test("parseJudgeResult accepts securityReviewPerformed:false", () => {
  const r = parseJudgeResult({ ...validPayload, securityReviewPerformed: false });
  assert.equal(r.securityReviewPerformed, false);
});

test("parseJudgeResult defaults securityReviewPerformed to true when omitted", () => {
  const noField = { ...validPayload } as Record<string, unknown>;
  delete noField["securityReviewPerformed"];
  const r = parseJudgeResult(noField);
  assert.equal(r.securityReviewPerformed, true);
});

test("parseJudgeResult rejects a non-boolean securityReviewPerformed", () => {
  const bad = { ...validPayload, securityReviewPerformed: "yes" };
  assert.throws(() => parseJudgeResult(bad), /must be a boolean/);
});

test("parseJudgeResult parses taskSolved true and false", () => {
  assert.equal(parseJudgeResult({ ...validPayload, taskSolved: true }).taskSolved, true);
  assert.equal(parseJudgeResult({ ...validPayload, taskSolved: false }).taskSolved, false);
});

test("parseJudgeResult leaves taskSolved undefined when omitted", () => {
  // validPayload has no taskSolved key; scoreRun (not the parser) supplies the default.
  assert.equal(parseJudgeResult(validPayload).taskSolved, undefined);
});

test("parseJudgeResult rejects a non-boolean taskSolved", () => {
  const bad = { ...validPayload, taskSolved: "nope" };
  assert.throws(() => parseJudgeResult(bad), /taskSolved.*must be a boolean/);
});

test("parseJudgeResult rejects a missing dimension", () => {
  const bad = { ...validPayload } as Record<string, unknown>;
  delete bad["securityQuality"];
  assert.throws(() => parseJudgeResult(bad), /securityQuality/);
});

test("parseJudgeResult rejects a non-integer score", () => {
  const bad = { ...validPayload, codeQuality: { score: 25.5, justification: "x" } };
  assert.throws(() => parseJudgeResult(bad), /non-integer/);
});

test("parseJudgeResult rejects a score above the dimension max", () => {
  // Primary backstop now that no CLI schema is enforced: reject inflated scores.
  const bad = { ...validPayload, testingCoverage: { score: 45, justification: "x" } };
  assert.throws(() => parseJudgeResult(bad), /out of range 0\.\.40/);
});

test("parseJudgeResult rejects a negative score", () => {
  const bad = { ...validPayload, documentation: { score: -1, justification: "x" } };
  assert.throws(() => parseJudgeResult(bad), /out of range 0\.\.10/);
});

test("parseJudgeResult tolerates missing summary (non-scoring) by defaulting to empty", () => {
  const noSummary = { ...validPayload } as Record<string, unknown>;
  delete noSummary["summary"];
  const r = parseJudgeResult(noSummary);
  assert.equal(r.summary, "");
  // Scores must still parse normally.
  assert.equal(r.codeQuality.score, validPayload.codeQuality.score);
});

/** Wrap a model response string in the CLI json envelope. */
function envelope(resultText: string): string {
  return JSON.stringify({ is_error: false, result: resultText });
}

test("extractJudgeJson parses a clean ```json fenced block", () => {
  const result = "```json\n" + JSON.stringify(validPayload) + "\n```";
  assert.deepEqual(extractJudgeJson(envelope(result)), validPayload);
});

test("extractJudgeJson parses a json block with surrounding prose", () => {
  const result =
    "Here is my assessment.\n\n```json\n" +
    JSON.stringify(validPayload) +
    "\n```\n\nLet me know if you need more.";
  assert.deepEqual(extractJudgeJson(envelope(result)), validPayload);
});

test("extractJudgeJson parses an unfenced bare object with leading prose", () => {
  const result = "Sure: " + JSON.stringify(validPayload);
  assert.deepEqual(extractJudgeJson(envelope(result)), validPayload);
});

test("extractJudgeJson handles nested braces via balanced scan", () => {
  const nested = { ...validPayload, summary: "uses {curly} braces inside" };
  const result = "prose { not json but has a brace\n```json\n" + JSON.stringify(nested) + "\n```";
  assert.deepEqual(extractJudgeJson(envelope(result)), nested);
});

test("extractJudgeJson ignores trailing prose INSIDE the fence (regression: senior-verbose)", () => {
  // The model sometimes appends explanation after the object, inside the fence,
  // which previously made JSON.parse throw "non-whitespace after JSON".
  const result =
    "```json\n" +
    JSON.stringify(validPayload) +
    "\n\nNote: I weighted testing heavily per the rubric.\n```";
  assert.deepEqual(extractJudgeJson(envelope(result)), validPayload);
});

test("extractJudgeJson ignores trailing text after an unfenced bare object", () => {
  const result = JSON.stringify(validPayload) + "\n\nThat's my final assessment.";
  assert.deepEqual(extractJudgeJson(envelope(result)), validPayload);
});

test("extractJudgeJson passes through an already-parsed .result object", () => {
  const env = JSON.stringify({ is_error: false, result: validPayload });
  assert.deepEqual(extractJudgeJson(env), validPayload);
});

test("extractJudgeJson throws when there is no JSON object in the response", () => {
  assert.throws(() => extractJudgeJson(envelope("I could not evaluate this.")), /No JSON object/);
});

test("extractJudgeJson throws on malformed JSON in the block", () => {
  const result = "```json\n{ \"codeQuality\": { \"score\": 10, }\n```"; // trailing comma
  assert.throws(() => extractJudgeJson(envelope(result)));
});

test("extractJudgeJson throws on an is_error envelope, surfacing the subtype", () => {
  const env = JSON.stringify({
    is_error: true,
    subtype: "error_max_structured_output_retries",
    result: "",
  });
  assert.throws(
    () => extractJudgeJson(env),
    /error_max_structured_output_retries/,
  );
});

test("parseJudgeResult composes with extractJudgeJson end to end", () => {
  const result = "```json\n" + JSON.stringify(validPayload) + "\n```";
  const r = parseJudgeResult(extractJudgeJson(envelope(result)));
  assert.equal(r.testingCoverage.score, 35);
});

test("truncateEvidence leaves under-cap text unchanged", () => {
  const text = "small diff";
  const out = truncateEvidence(text, 1000, "diff");
  assert.equal(out.truncated, false);
  assert.equal(out.text, text);
});

test("truncateEvidence truncates over-cap text and appends a marker", () => {
  const text = "x".repeat(500);
  const out = truncateEvidence(text, 100, "diff");
  assert.equal(out.truncated, true);
  assert.match(out.text, /\[\.\.\. diff truncated at 100 bytes for evaluation \.\.\.\]$/);
  // Body is capped to the byte limit (plus the appended marker).
  assert.equal(out.text.startsWith("x".repeat(100)), true);
  assert.ok(out.text.length < text.length + 100);
});

test("truncateEvidence respects the byte cap exactly at the boundary", () => {
  const text = "abcd";
  assert.equal(truncateEvidence(text, 4, "t").truncated, false);
  assert.equal(truncateEvidence(text, 3, "t").truncated, true);
});

// --- buildJudgePrompt: correctness-gating -----------------------------------

const promptArgs = {
  taskTitle: "Fix the deadlock",
  taskPrompt: "There is a hidden deadlock; find and fix it.",
  diff: "some diff",
  fileSummary: "- a.ts [source]",
  transcript: "assistant did work",
};

test("buildJudgePrompt injects the success-criteria block and a taskSolved instruction when gated", () => {
  const p = buildJudgePrompt({
    ...promptArgs,
    successCriteria: "The lock-ordering deadlock must be located and eliminated.",
  });
  assert.match(p, /## Task-specific success criteria/);
  assert.match(p, /lock-ordering deadlock must be located and eliminated/);
  assert.match(p, /"taskSolved"/);
});

test("buildJudgePrompt without successCriteria omits the block and taskSolved (base template unchanged)", () => {
  const p = buildJudgePrompt(promptArgs);
  assert.doesNotMatch(p, /Task-specific success criteria/);
  assert.doesNotMatch(p, /taskSolved/);
});
