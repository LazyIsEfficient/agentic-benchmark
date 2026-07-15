import assert from "node:assert/strict";
import { test } from "node:test";
import { JUDGE_MAX_ATTEMPTS, MAX_DIFF_BYTES } from "./config.js";
import {
  extractJudgeJson,
  judgeCell,
  parseCellJudgeResult,
  truncateEvidence,
} from "./judge.js";

/** A representative judge-shaped JSON payload for the extraction tests. */
const validPayload = {
  codeQuality: { score: 25, justification: "clean" },
  testingCoverage: { score: 35, justification: "thorough" },
  securityQuality: { score: 18, justification: "reviewed" },
  documentation: { score: 8, justification: "documented" },
  securityReviewPerformed: true,
  summary: "great",
};

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

// --- Structured cell judge: parseCellJudgeResult ------------------------------

const validCellPayload = {
  craft: {
    naming: { score: 3, evidence: ["src/a.ts:12 — loginLimiter names intent"] },
    structure: { score: 2, evidence: ["src/a.ts:20 — one right-sized function"] },
    consistency: { score: 4, evidence: ["src/a.ts:5 — matches existing import style"] },
    economy: { score: 3, evidence: ["src/a.ts:1 — 14-line diff for the task"] },
    documentation: { score: 3, evidence: ["src/a.ts:2 — docstring explains the retry budget"] },
  },
  blast_radius: [],
  correctness_assessment: null,
  flags: [],
};

/** Rebuild the payload with one craft dimension replaced (untyped on purpose). */
function withCraftDim(dim: string, value: unknown): Record<string, unknown> {
  return {
    ...validCellPayload,
    craft: { ...validCellPayload.craft, [dim]: value },
  };
}

test("parseCellJudgeResult accepts a well-formed payload", () => {
  const r = parseCellJudgeResult(JSON.stringify(validCellPayload));
  assert.equal(r.craft.naming.score, 3);
  assert.equal(r.craft.consistency.score, 4);
  assert.deepEqual(r.craft.economy.evidence, ["src/a.ts:1 — 14-line diff for the task"]);
  assert.deepEqual(r.blastRadius, []);
  assert.equal(r.correctnessAssessment, null);
  assert.deepEqual(r.flags, []);
});

test("parseCellJudgeResult parses the documentation dimension like any other craft score", () => {
  const r = parseCellJudgeResult(JSON.stringify(validCellPayload));
  assert.equal(r.craft.documentation.score, 3);
  assert.deepEqual(r.craft.documentation.evidence, [
    "src/a.ts:2 — docstring explains the retry budget",
  ]);
});

test("parseCellJudgeResult fails a missing/malformed documentation dimension closed to unknown", () => {
  // Missing entirely → unknown + invalid:documentation flag (fail-closed), and
  // siblings stay intact (field-level validation).
  const { documentation: _d, ...craftNoDoc } = validCellPayload.craft;
  const missing = parseCellJudgeResult(
    JSON.stringify({ ...validCellPayload, craft: craftNoDoc }),
  );
  assert.equal(missing.craft.documentation.score, "unknown");
  assert.deepEqual(missing.craft.documentation.evidence, []);
  assert.ok(missing.flags.includes("invalid:documentation"));
  assert.equal(missing.craft.naming.score, 3);

  // A numeric documentation score WITHOUT evidence is invalid per the rubric.
  const noEvidence = parseCellJudgeResult(
    JSON.stringify(withCraftDim("documentation", { score: 4, evidence: [] })),
  );
  assert.equal(noEvidence.craft.documentation.score, "unknown");
  assert.ok(noEvidence.flags.includes("invalid:documentation"));
});

test("parseCellJudgeResult parses fence-wrapped JSON with surrounding prose", () => {
  const raw =
    "Here is my verdict.\n```json\n" +
    JSON.stringify(validCellPayload) +
    "\n```\nHope that helps.";
  const r = parseCellJudgeResult(raw);
  assert.equal(r.craft.structure.score, 2);
});

test("parseCellJudgeResult throws when no JSON object exists (feeds the re-ask)", () => {
  assert.throws(() => parseCellJudgeResult("I cannot judge this."), /No JSON object/);
});

test("parseCellJudgeResult throws on malformed JSON in the balanced span", () => {
  assert.throws(() => parseCellJudgeResult('{"craft": nonsense}'));
});

test("parseCellJudgeResult fails an out-of-range craft score closed — never clamped", () => {
  const above = parseCellJudgeResult(
    JSON.stringify(withCraftDim("naming", { score: 7, evidence: ["src/a.ts:1 — q"] })),
  );
  assert.equal(above.craft.naming.score, "unknown"); // NOT clamped to 4
  assert.deepEqual(above.craft.naming.evidence, []);
  assert.ok(above.flags.includes("invalid:naming"));
  // Sibling dimensions are untouched — validation is field-level.
  assert.equal(above.craft.structure.score, 2);

  const below = parseCellJudgeResult(
    JSON.stringify(withCraftDim("naming", { score: -1, evidence: ["src/a.ts:1 — q"] })),
  );
  assert.equal(below.craft.naming.score, "unknown"); // NOT clamped to 0
  assert.ok(below.flags.includes("invalid:naming"));
});

test("parseCellJudgeResult fails a non-integer craft score closed", () => {
  const r = parseCellJudgeResult(
    JSON.stringify(withCraftDim("structure", { score: 2.5, evidence: ["src/a.ts:1 — q"] })),
  );
  assert.equal(r.craft.structure.score, "unknown");
  assert.ok(r.flags.includes("invalid:structure"));
});

test("parseCellJudgeResult invalidates a numeric craft score without evidence", () => {
  const r = parseCellJudgeResult(
    JSON.stringify(withCraftDim("economy", { score: 4, evidence: [] })),
  );
  assert.equal(r.craft.economy.score, "unknown");
  assert.deepEqual(r.craft.economy.evidence, []);
  assert.ok(r.flags.includes("invalid:economy"));
});

test("parseCellJudgeResult accepts an explicit unknown score with empty evidence", () => {
  const r = parseCellJudgeResult(
    JSON.stringify(withCraftDim("consistency", { score: "unknown", evidence: [] })),
  );
  assert.equal(r.craft.consistency.score, "unknown");
  assert.deepEqual(r.flags, []); // legal fail-closed shape — no invalid flag
});

test("parseCellJudgeResult fails every craft dim closed when craft is missing", () => {
  const noCraft = { ...validCellPayload } as Record<string, unknown>;
  delete noCraft["craft"];
  const r = parseCellJudgeResult(JSON.stringify(noCraft));
  for (const dim of ["naming", "structure", "consistency", "economy"] as const) {
    assert.equal(r.craft[dim].score, "unknown");
    assert.ok(r.flags.includes(`invalid:${dim}`));
  }
});

test("parseCellJudgeResult truncates over-long evidence strings to 120 chars", () => {
  const long = "e".repeat(300);
  const r = parseCellJudgeResult(
    JSON.stringify(withCraftDim("naming", { score: 3, evidence: [long] })),
  );
  assert.equal(r.craft.naming.evidence[0]!.length, 120);
});

test("parseCellJudgeResult keeps valid blast entries and truncates their evidence", () => {
  const payload = {
    ...validCellPayload,
    blast_radius: [
      { file: "src/other.ts", classification: "overreach", evidence: "z".repeat(300) },
      { file: "src/shared.ts", classification: "necessary", evidence: "shared type" },
    ],
  };
  const r = parseCellJudgeResult(JSON.stringify(payload));
  assert.equal(r.blastRadius.length, 2);
  assert.equal(r.blastRadius[0]!.classification, "overreach");
  assert.equal(r.blastRadius[0]!.evidence.length, 120);
  assert.equal(r.blastRadius[1]!.file, "src/shared.ts");
  assert.deepEqual(r.flags, []);
});

test("parseCellJudgeResult drops a blast entry with an unknown classification, flagging its file", () => {
  const payload = {
    ...validCellPayload,
    blast_radius: [{ file: "src/x.ts", classification: "sneaky", evidence: "e" }],
  };
  const r = parseCellJudgeResult(JSON.stringify(payload));
  assert.deepEqual(r.blastRadius, []);
  assert.ok(r.flags.includes("invalid-blast-entry:src/x.ts"));
});

test("parseCellJudgeResult drops a blast entry missing its file, flagging by index", () => {
  const payload = {
    ...validCellPayload,
    blast_radius: [{ classification: "necessary", evidence: "e" }],
  };
  const r = parseCellJudgeResult(JSON.stringify(payload));
  assert.deepEqual(r.blastRadius, []);
  assert.ok(r.flags.includes("invalid-blast-entry:0"));
});

test("parseCellJudgeResult replaces a non-array blast_radius with [] and flags it", () => {
  const payload = { ...validCellPayload, blast_radius: "none" };
  const r = parseCellJudgeResult(JSON.stringify(payload));
  assert.deepEqual(r.blastRadius, []);
  assert.ok(r.flags.includes("invalid:blast_radius"));
});

test("parseCellJudgeResult normalizes classification whitespace/case for every entry", () => {
  const payload = {
    ...validCellPayload,
    blast_radius: [
      { file: "src/a.ts", classification: " Adversarial ", evidence: "weakened test" },
      { file: "src/b.ts", classification: "Necessary", evidence: "e" },
    ],
  };
  const r = parseCellJudgeResult(JSON.stringify(payload));
  assert.equal(r.blastRadius.length, 2, "cosmetically-garbled classifications are not dropped");
  assert.equal(r.blastRadius[0]!.classification, "adversarial");
  assert.equal(r.blastRadius[1]!.classification, "necessary");
  assert.deepEqual(r.flags, []);
});

test("parseCellJudgeResult NEVER drops an adversarial entry — missing file is coerced", () => {
  // Dropping a garbled adversarial entry would fail OPEN for disqualification.
  const payload = {
    ...validCellPayload,
    blast_radius: [{ classification: "adversarial" }],
  };
  const r = parseCellJudgeResult(JSON.stringify(payload));
  assert.equal(r.blastRadius.length, 1);
  assert.deepEqual(r.blastRadius[0], {
    file: "(unspecified)",
    classification: "adversarial",
    evidence: "",
  });
  assert.ok(r.flags.includes("coerced-blast-entry:0"), "the coercion is flagged, not silent");
});

test("parseCellJudgeResult coerces an adversarial entry's non-string file and missing evidence", () => {
  const payload = {
    ...validCellPayload,
    blast_radius: [{ file: 42, classification: "ADVERSARIAL", evidence: 7 }],
  };
  const r = parseCellJudgeResult(JSON.stringify(payload));
  assert.equal(r.blastRadius.length, 1);
  assert.equal(r.blastRadius[0]!.file, "(unspecified)");
  assert.equal(r.blastRadius[0]!.classification, "adversarial");
  assert.equal(r.blastRadius[0]!.evidence, "");
});

test("parseCellJudgeResult still drops a NON-adversarial entry missing its file", () => {
  const payload = {
    ...validCellPayload,
    blast_radius: [{ classification: " Overreach " }],
  };
  const r = parseCellJudgeResult(JSON.stringify(payload));
  assert.deepEqual(r.blastRadius, []);
  assert.ok(r.flags.includes("invalid-blast-entry:0"));
});

test("parseCellJudgeResult keeps a valid correctness assessment", () => {
  const payload = {
    ...validCellPayload,
    correctness_assessment: {
      verdict: "likely_correct",
      evidence: ["src/a.ts:3 — handles the empty case"],
    },
  };
  const r = parseCellJudgeResult(JSON.stringify(payload));
  assert.equal(r.correctnessAssessment?.verdict, "likely_correct");
  assert.deepEqual(r.correctnessAssessment?.evidence, ["src/a.ts:3 — handles the empty case"]);
});

test("parseCellJudgeResult keeps null correctness_assessment as null without flags", () => {
  const r = parseCellJudgeResult(JSON.stringify(validCellPayload));
  assert.equal(r.correctnessAssessment, null);
  assert.deepEqual(r.flags, []);
});

test("parseCellJudgeResult fails an invalid correctness verdict closed to unknown", () => {
  const payload = {
    ...validCellPayload,
    correctness_assessment: { verdict: "definitely_correct", evidence: ["e"] },
  };
  const r = parseCellJudgeResult(JSON.stringify(payload));
  assert.deepEqual(r.correctnessAssessment, { verdict: "unknown", evidence: [] });
  assert.ok(r.flags.includes("invalid:correctness_assessment"));
});

test("parseCellJudgeResult coerces flags: drops non-strings and caps at 20", () => {
  const manyFlags: unknown[] = [1, null, {}, ...Array.from({ length: 30 }, (_, i) => `f${i}`)];
  const r = parseCellJudgeResult(JSON.stringify({ ...validCellPayload, flags: manyFlags }));
  assert.equal(r.flags.length, 20);
  assert.equal(r.flags[0], "f0");
  assert.equal(r.flags[19], "f19");
});

// --- Structured cell judge: judgeCell -----------------------------------------

/** Wrap a model response string in a fake judge ContainerResult. */
function cellEnvelope(resultText: string) {
  return {
    stdout: JSON.stringify({ is_error: false, result: resultText, duration_ms: 1200 }),
    stderr: "",
    exitCode: 0,
    timedOut: false,
    wallMs: 40,
  };
}

const cellInputs = {
  taskPrompt: "Add a rate limiter.",
  conventionsList: "- shared logger",
  anchorVerdict: "held",
  testResultsSummary: "none",
  slopMetricsJson: "{}",
  outOfScopeFiles: [],
  diff: "+const x = 1;",
};

test("judgeCell returns a parsed verdict on the first clean response", async () => {
  const prompts: string[] = [];
  const out = await judgeCell(cellInputs, {
    runJudgeFn: async ({ judgePrompt }) => {
      prompts.push(judgePrompt);
      return cellEnvelope(JSON.stringify(validCellPayload));
    },
  });
  assert.equal(out.judgeFailure, undefined);
  assert.equal(out.result.craft.naming.score, 3);
  assert.equal(out.evidenceTruncated, false);
  assert.equal(prompts.length, 1);
  assert.equal(out.metrics?.durationMs, 1200); // envelope metrics captured
});

test("judgeCell re-asks once on a parse failure and succeeds on corrected output", async () => {
  const prompts: string[] = [];
  const out = await judgeCell(cellInputs, {
    runJudgeFn: async ({ judgePrompt }) => {
      prompts.push(judgePrompt);
      return cellEnvelope(
        prompts.length === 1
          ? "I refuse to answer in JSON."
          : JSON.stringify(validCellPayload),
      );
    },
  });
  assert.equal(out.judgeFailure, undefined);
  assert.equal(out.result.craft.consistency.score, 4);
  assert.equal(prompts.length, 2);
  // The re-ask is the original prompt plus the quoted raw output and the
  // corrective instruction — exactly one re-ask, spec-mandated wording.
  assert.ok(prompts[1]!.startsWith(prompts[0]!));
  assert.ok(prompts[1]!.includes("Your previous output could not be parsed as JSON:"));
  assert.ok(prompts[1]!.includes("I refuse to answer in JSON."));
  assert.ok(prompts[1]!.includes("Output valid JSON only."));
});

test("judgeCell fails closed after a second parse failure — deterministic axes survive", async () => {
  let calls = 0;
  const out = await judgeCell(cellInputs, {
    runJudgeFn: async () => {
      calls++;
      return cellEnvelope("still not json");
    },
  });
  assert.equal(calls, 2); // original ask + exactly ONE re-ask
  assert.ok(out.judgeFailure);
  assert.match(out.judgeFailure!, /could not be parsed after one re-ask/);
  assert.deepEqual(out.result.flags, ["judge-parse-failure"]);
  assert.equal(out.result.craft.naming.score, "unknown");
  assert.equal(out.result.craft.economy.score, "unknown");
  assert.deepEqual(out.result.blastRadius, []);
  assert.equal(out.result.correctnessAssessment, null);
});

test("judgeCell fails closed when transport dies on every attempt", async () => {
  let calls = 0;
  const out = await judgeCell(cellInputs, {
    runJudgeFn: async () => {
      calls++;
      return { stdout: "", stderr: "boom", exitCode: 1, timedOut: false, wallMs: 5 };
    },
    sleepFn: async () => {}, // no real backoff in tests
  });
  assert.equal(calls, JUDGE_MAX_ATTEMPTS);
  assert.ok(out.judgeFailure);
  assert.match(out.judgeFailure!, /container exit 1/);
  assert.deepEqual(out.result.flags, ["judge-transport-failure"]);
  assert.equal(out.result.craft.structure.score, "unknown");
});

test("judgeCell retries transport errors within an ask (is_error envelope), then succeeds", async () => {
  let calls = 0;
  const out = await judgeCell(cellInputs, {
    runJudgeFn: async () => {
      calls++;
      if (calls === 1) {
        return {
          stdout: JSON.stringify({ is_error: true, subtype: "overloaded", result: "" }),
          stderr: "",
          exitCode: 0,
          timedOut: false,
          wallMs: 5,
        };
      }
      return cellEnvelope(JSON.stringify(validCellPayload));
    },
    sleepFn: async () => {},
  });
  assert.equal(calls, 2);
  assert.equal(out.judgeFailure, undefined);
  assert.equal(out.result.craft.naming.score, 3);
});

test("judgeCell keeps the correctness assessment when no tests exist", async () => {
  const payload = {
    ...validCellPayload,
    correctness_assessment: {
      verdict: "likely_incorrect",
      evidence: ["src/a.ts:9 — off-by-one in the loop bound"],
    },
  };
  const out = await judgeCell(
    { ...cellInputs, testResultsSummary: "none" },
    { runJudgeFn: async () => cellEnvelope(JSON.stringify(payload)) },
  );
  assert.equal(out.result.correctnessAssessment?.verdict, "likely_incorrect");
  assert.equal(out.result.flags.includes("correctness-assessment-ignored"), false);
});

test("judgeCell forces correctness_assessment to null when tests ran (harness owns it)", async () => {
  const payload = {
    ...validCellPayload,
    correctness_assessment: { verdict: "likely_correct", evidence: ["e"] },
  };
  const out = await judgeCell(
    { ...cellInputs, testResultsSummary: "3 passed, 0 failed" },
    { runJudgeFn: async () => cellEnvelope(JSON.stringify(payload)) },
  );
  assert.equal(out.result.correctnessAssessment, null);
  assert.ok(out.result.flags.includes("correctness-assessment-ignored"));
});

test("judgeCell surfaces evidenceTruncated and sends the truncation marker for an oversized diff", async () => {
  const prompts: string[] = [];
  const out = await judgeCell(
    { ...cellInputs, diff: "y".repeat(MAX_DIFF_BYTES + 10) },
    {
      runJudgeFn: async ({ judgePrompt }) => {
        prompts.push(judgePrompt);
        return cellEnvelope(JSON.stringify(validCellPayload));
      },
    },
  );
  assert.equal(out.evidenceTruncated, true);
  assert.ok(prompts[0]!.includes("[DIFF TRUNCATED]"));
});
