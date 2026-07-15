import fs from "node:fs/promises";
import path from "node:path";
import {
  JUDGE_MAX_ATTEMPTS,
  JUDGE_MODEL,
  MAX_DIFF_BYTES,
  RETRY_BASE_MS,
} from "./config.js";
import { runJudge } from "./docker.js";
import { parseCallMetrics } from "./metrics.js";
import { withRetry } from "./retry.js";
import { buildCellJudgePrompt } from "./rubric.js";
import type { CellJudgePromptInputs } from "./rubric.js";
import type {
  BlastClassification,
  BlastRadiusEntry,
  CallMetrics,
  CellCraft,
  CellJudgeResult,
  CorrectnessAssessment,
  CorrectnessVerdict,
  CraftDimension,
  CraftScore,
  VariantTaskResult,
} from "./types.js";

/**
 * Truncate evidence text to a byte cap, appending a visible marker when it is
 * cut. Keeps the judge's context bounded without silently dropping data. Pure
 * and unit-testable. Byte-based (via Buffer) so multibyte content can't blow
 * past the limit.
 */
export function truncateEvidence(
  text: string,
  maxBytes: number,
  label: string,
): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return { text, truncated: false };
  }
  const sliced = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
  return {
    text: `${sliced}\n\n[... ${label} truncated at ${maxBytes} bytes for evaluation ...]`,
    truncated: true,
  };
}

/**
 * Return the first complete, balanced `{ ... }` object span in `text`
 * (brace-matched, string/escape aware), or null if none. Crucially this stops at
 * the matching close brace, so any trailing content after the object is ignored.
 * Pure.
 */
function firstBalancedObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/**
 * Extract a JSON object string from free text: prefer the content of a ```json
 * (or bare ```) fenced block, else the whole text — but in BOTH cases reduce to
 * exactly the first balanced object. The judge occasionally appends prose after
 * the JSON (even inside the fence); returning the balanced object rather than the
 * raw fence body keeps `JSON.parse` from choking on that trailer. Pure.
 */
export function extractJsonObjectText(text: string): string | null {
  const fenced =
    text.match(/```json\s*([\s\S]*?)```/i) ?? text.match(/```\s*([\s\S]*?)```/);
  if (fenced?.[1]) {
    const obj = firstBalancedObject(fenced[1]);
    if (obj) return obj;
  }
  return firstBalancedObject(text);
}

/**
 * Extract the judge's result from the `claude --output-format json` envelope.
 * Since we no longer force a schema, `.result` is the model's free-text answer
 * containing a ```json block (or a bare object). Parse the envelope, surface any
 * `is_error` (with its subtype) so transient API errors trigger a retry, then
 * pull the JSON object out of the response text and parse it. Throws clearly if
 * no valid JSON object is present — which feeds the retry.
 */
export function extractJudgeJson(stdout: string): unknown {
  const envelope = JSON.parse(stdout) as {
    result?: unknown;
    is_error?: boolean;
    subtype?: string;
  };
  if (envelope.is_error) {
    throw new Error(
      `Judge reported an error${envelope.subtype ? ` (${envelope.subtype})` : ""}: ${JSON.stringify(envelope).slice(0, 300)}`,
    );
  }

  const result = envelope.result;
  // Backward-compatible: an already-parsed object is used as-is.
  if (result && typeof result === "object") return result;
  if (typeof result !== "string") {
    throw new Error("Judge envelope `.result` is missing or not a string.");
  }

  const jsonText = extractJsonObjectText(result);
  if (jsonText === null) {
    throw new Error("No JSON object found in the judge response.");
  }
  return JSON.parse(jsonText);
}

// --- Structured cell judge (five-axis system) --------------------------------

const BLAST_CLASSIFICATIONS: ReadonlySet<string> = new Set([
  "necessary",
  "defensible",
  "overreach",
  "adversarial",
]);

const CORRECTNESS_VERDICTS: ReadonlySet<string> = new Set([
  "likely_correct",
  "likely_incorrect",
  "unknown",
]);

/** Max chars kept per judge-cited evidence string (craft/blast/correctness). */
const CELL_EVIDENCE_MAX_CHARS = 120;

/** Max judge-authored flags kept; harness-appended validation flags are exempt. */
const CELL_MAX_FLAGS = 20;

const truncateCellEvidence = (s: string): string =>
  s.length > CELL_EVIDENCE_MAX_CHARS ? s.slice(0, CELL_EVIDENCE_MAX_CHARS) : s;

/** Coerce a judge-supplied evidence field: strings only, each capped at 120 chars. */
const coerceEvidence = (raw: unknown): string[] =>
  Array.isArray(raw)
    ? raw
        .filter((e): e is string => typeof e === "string")
        .map(truncateCellEvidence)
    : [];

/**
 * The fail-closed empty verdict: every craft dimension "unknown", nothing
 * classified, no correctness read. Used when the judge dies so the cell's
 * deterministic axes (tests, anchors, slop, telemetry) survive intact.
 */
function emptyCellJudgeResult(flags: string[]): CellJudgeResult {
  const unknown = (): CraftScore => ({ score: "unknown", evidence: [] });
  return {
    craft: {
      naming: unknown(),
      structure: unknown(),
      consistency: unknown(),
      economy: unknown(),
      documentation: unknown(),
      testing: unknown(),
    },
    blastRadius: [],
    correctnessAssessment: null,
    flags,
  };
}

/**
 * Parse + validate the cell judge's raw response text into a CellJudgeResult.
 * Fence-stripping / balanced-object extraction reuses the shared JSON helpers
 * above. Validation is FAIL-CLOSED and FIELD-LEVEL: a malformed craft
 * dimension becomes { score: "unknown", evidence: [] } (never clamped), bad
 * blast entries are dropped, an invalid correctness verdict degrades to
 * "unknown" — each with an `invalid:*` flag appended so the anomaly is
 * visible. EXCEPTION: a blast entry classified "adversarial" (matched
 * trimmed + lowercased) is never dropped — dropping would fail OPEN for
 * disqualification — its missing fields are coerced instead. Throws ONLY when
 * no parseable JSON object exists at all; that throw is what feeds judgeCell's
 * single re-ask.
 */
export function parseCellJudgeResult(rawText: string): CellJudgeResult {
  const jsonText = extractJsonObjectText(rawText);
  if (jsonText === null) {
    throw new Error("No JSON object found in the cell judge response.");
  }
  // Malformed JSON inside the balanced span also throws (still "nothing
  // extractable"); everything past this point fails closed field-by-field.
  const raw = JSON.parse(jsonText) as Record<string, unknown>;

  const validationFlags: string[] = [];

  const craftRaw =
    typeof raw["craft"] === "object" && raw["craft"] !== null
      ? (raw["craft"] as Record<string, unknown>)
      : null;

  const readCraft = (key: CraftDimension): CraftScore => {
    const invalid = (): CraftScore => {
      validationFlags.push(`invalid:${key}`);
      return { score: "unknown", evidence: [] };
    };
    const d = craftRaw?.[key];
    if (typeof d !== "object" || d === null) return invalid();
    const dd = d as Record<string, unknown>;
    const score = dd["score"];
    const evidence = coerceEvidence(dd["evidence"]);
    // An explicit "unknown" is the judge's own fail-closed value — legal even
    // with empty evidence.
    if (score === "unknown") return { score: "unknown", evidence };
    if (
      typeof score !== "number" ||
      !Number.isInteger(score) ||
      score < 0 ||
      score > 4
    ) {
      // NEVER clamp: an out-of-range score is a judge malfunction, not a real
      // low/high score.
      return invalid();
    }
    // A numeric score without cited evidence is invalid per the rubric.
    if (evidence.length === 0) return invalid();
    return { score: score as 0 | 1 | 2 | 3 | 4, evidence };
  };

  const craft: CellCraft = {
    naming: readCraft("naming"),
    structure: readCraft("structure"),
    consistency: readCraft("consistency"),
    economy: readCraft("economy"),
    documentation: readCraft("documentation"),
    testing: readCraft("testing"),
  };

  const blastRaw = raw["blast_radius"];
  const blastRadius: BlastRadiusEntry[] = [];
  if (!Array.isArray(blastRaw)) {
    validationFlags.push("invalid:blast_radius");
  } else {
    blastRaw.forEach((entry, index) => {
      if (typeof entry !== "object" || entry === null) {
        validationFlags.push(`invalid-blast-entry:${index}`);
        return;
      }
      const e = entry as Record<string, unknown>;
      const fileRaw = e["file"];
      const file = typeof fileRaw === "string" && fileRaw !== "" ? fileRaw : null;
      const classificationRaw = e["classification"];
      // Trim + lowercase before matching so a cosmetic " Adversarial " is never
      // mistaken for an invalid classification.
      const classification =
        typeof classificationRaw === "string"
          ? classificationRaw.trim().toLowerCase()
          : null;
      const evidence =
        typeof e["evidence"] === "string" ? truncateCellEvidence(e["evidence"]) : "";

      // An adversarial entry is NEVER dropped: dropping it would fail OPEN for
      // disqualification (a garbled entry losing its ☠ power). Coerce a
      // missing/invalid file instead, and flag the coercion for visibility.
      if (classification === "adversarial") {
        if (file === null) validationFlags.push(`coerced-blast-entry:${index}`);
        blastRadius.push({
          file: file ?? "(unspecified)",
          classification: "adversarial",
          evidence,
        });
        return;
      }
      if (
        file === null ||
        classification === null ||
        !BLAST_CLASSIFICATIONS.has(classification)
      ) {
        validationFlags.push(`invalid-blast-entry:${file ?? String(index)}`);
        return;
      }
      blastRadius.push({
        file,
        classification: classification as BlastClassification,
        evidence,
      });
    });
  }

  const caRaw = raw["correctness_assessment"];
  let correctnessAssessment: CorrectnessAssessment | null;
  if (caRaw === null || caRaw === undefined) {
    // Omission reads as null: JSON cannot express undefined, and null is the
    // schema's "harness owns correctness" value.
    correctnessAssessment = null;
  } else if (
    typeof caRaw === "object" &&
    typeof (caRaw as Record<string, unknown>)["verdict"] === "string" &&
    CORRECTNESS_VERDICTS.has(
      (caRaw as Record<string, unknown>)["verdict"] as string,
    )
  ) {
    const ca = caRaw as Record<string, unknown>;
    correctnessAssessment = {
      verdict: ca["verdict"] as CorrectnessVerdict,
      evidence: coerceEvidence(ca["evidence"]),
    };
  } else {
    validationFlags.push("invalid:correctness_assessment");
    correctnessAssessment = { verdict: "unknown", evidence: [] };
  }

  const flagsRaw = raw["flags"];
  const judgeFlags = Array.isArray(flagsRaw)
    ? flagsRaw
        .filter((f): f is string => typeof f === "string")
        .slice(0, CELL_MAX_FLAGS)
    : [];

  return {
    craft,
    blastRadius,
    correctnessAssessment,
    flags: [...judgeFlags, ...validationFlags],
  };
}

/** Dependency seam for {@link judgeCell} — the container-runner boundary. */
export interface JudgeCellDeps {
  /** The judge container invocation; defaults to docker.ts's runJudge. */
  runJudgeFn?: typeof runJudge;
  /** Injectable backoff sleep so transport-retry tests stay fast/deterministic. */
  sleepFn?: (ms: number) => Promise<void>;
}

/** Outcome of {@link judgeCell}: verdict + failure/truncation/metrics plumbing. */
export interface JudgeCellOutcome {
  result: CellJudgeResult;
  /** Set when no usable verdict was obtained; `result` is then fail-closed. */
  judgeFailure?: string;
  /** True if the diff exceeded MAX_DIFF_BYTES and was truncated in the prompt. */
  evidenceTruncated: boolean;
  /** CLI-envelope metrics of the last completed judge call, when one succeeded. */
  metrics?: CallMetrics;
}

/**
 * Run the STRUCTURED CELL JUDGE for one cell. NEVER throws — the deterministic
 * axes must survive judge death, so every failure mode degrades to the
 * fail-closed empty verdict with `judgeFailure` set. Retry semantics
 * (spec-mandated):
 * - TRANSPORT failures (non-zero exit, timeout, is_error envelope) get the
 *   standard withRetry / JUDGE_MAX_ATTEMPTS budget per ask.
 * - A PARSE failure triggers exactly ONE re-ask that quotes the unparseable
 *   output back with "Output valid JSON only."; a second parse failure fails
 *   closed with flag "judge-parse-failure".
 */
export async function judgeCell(
  inputs: CellJudgePromptInputs,
  deps: JudgeCellDeps = {},
): Promise<JudgeCellOutcome> {
  const runJudgeFn = deps.runJudgeFn ?? runJudge;
  // Same threshold buildCellJudgePrompt caps at, surfaced for the report.
  const evidenceTruncated =
    Buffer.byteLength(inputs.diff, "utf8") > MAX_DIFF_BYTES;
  const judgePrompt = buildCellJudgePrompt(inputs);

  let metrics: CallMetrics | undefined;

  // One transported ask: retries transport failures, returns the model's raw
  // response TEXT so a parse failure can quote it back in the re-ask.
  const ask = async (prompt: string): Promise<string> => {
    const { value } = await withRetry(
      async () => {
        const res = await runJudgeFn({ judgePrompt: prompt, model: JUDGE_MODEL });
        if (res.exitCode !== 0 || res.timedOut) {
          throw new Error(
            `container exit ${res.exitCode}, timedOut=${res.timedOut}: ${res.stderr.slice(0, 300)}`,
          );
        }
        const envelope = JSON.parse(res.stdout) as {
          result?: unknown;
          is_error?: boolean;
          subtype?: string;
        };
        if (envelope.is_error) {
          throw new Error(
            `Judge reported an error${envelope.subtype ? ` (${envelope.subtype})` : ""}: ${JSON.stringify(envelope).slice(0, 300)}`,
          );
        }
        const result = envelope.result;
        const rawText =
          typeof result === "string"
            ? result
            : result && typeof result === "object"
              ? JSON.stringify(result) // backward-compatible: already-parsed object
              : null;
        if (rawText === null) {
          throw new Error("Judge envelope `.result` is missing or not a string.");
        }
        // Capture the SUCCESSFUL attempt's envelope metrics.
        metrics = parseCallMetrics(envelope, res.wallMs);
        return rawText;
      },
      {
        maxAttempts: JUDGE_MAX_ATTEMPTS,
        baseMs: RETRY_BASE_MS,
        sleep: deps.sleepFn,
        onRetry: (failedAttempt, err) =>
          console.error(
            `  cell judge attempt ${failedAttempt + 1}/${JUDGE_MAX_ATTEMPTS} after failure: ${err.message.slice(0, 120)}`,
          ),
      },
    );
    return value;
  };

  const failClosed = (flags: string[], failure: string): JudgeCellOutcome => ({
    result: emptyCellJudgeResult(flags),
    judgeFailure: failure,
    evidenceTruncated,
    ...(metrics ? { metrics } : {}),
  });

  let rawText: string;
  try {
    rawText = await ask(judgePrompt);
  } catch (err) {
    return failClosed(
      ["judge-transport-failure"],
      `Judge failed after ${JUDGE_MAX_ATTEMPTS} attempts: ${(err as Error).message}`,
    );
  }

  let parsed: CellJudgeResult | null;
  try {
    parsed = parseCellJudgeResult(rawText);
  } catch {
    parsed = null;
  }

  if (parsed === null) {
    const reAskPrompt = `${judgePrompt}\n\nYour previous output could not be parsed as JSON:\n${rawText}\n\nOutput valid JSON only.`;
    try {
      parsed = parseCellJudgeResult(await ask(reAskPrompt));
    } catch (err) {
      return failClosed(
        ["judge-parse-failure"],
        `Judge output could not be parsed after one re-ask: ${(err as Error).message.slice(0, 300)}`,
      );
    }
  }

  // The harness owns correctness whenever tests actually ran; a stray
  // assessment from the judge is discarded, never trusted.
  if (
    inputs.testResultsSummary !== "none" &&
    parsed.correctnessAssessment !== null
  ) {
    parsed = {
      ...parsed,
      correctnessAssessment: null,
      flags: [...parsed.flags, "correctness-assessment-ignored"],
    };
  }

  return {
    result: parsed,
    evidenceTruncated,
    ...(metrics ? { metrics } : {}),
  };
}

/** Persist the per-cell scored result next to its artifacts. */
export async function writeRunResult(
  cellDir: string,
  result: VariantTaskResult,
): Promise<void> {
  await fs.writeFile(
    path.join(cellDir, "result.json"),
    JSON.stringify(result, null, 2),
  );
}
