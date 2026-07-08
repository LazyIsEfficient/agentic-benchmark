import fs from "node:fs/promises";
import path from "node:path";
import {
  DIMENSION_MAX,
  JUDGE_MAX_ATTEMPTS,
  JUDGE_MODEL,
  MAX_DIFF_BYTES,
  MAX_TRANSCRIPT_BYTES,
  RETRY_BASE_MS,
} from "./config.js";
import { runJudge } from "./docker.js";
import { parseCallMetrics } from "./metrics.js";
import { withRetry } from "./retry.js";
import { buildJudgePrompt, scoreRun } from "./rubric.js";
import type {
  CallMetrics,
  JudgeResult,
  RunArtifacts,
  Task,
  VariantTaskResult,
} from "./types.js";

/** Render the classified file list into the summary block for the judge. */
export function buildFileSummary(artifacts: RunArtifacts): string {
  if (artifacts.changedFiles.length === 0) return "(no files changed)";
  return artifacts.changedFiles
    .map((f) => `- ${f.path} [${f.kind}]`)
    .join("\n");
}

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

const DIMENSION_KEYS = [
  "codeQuality",
  "testingCoverage",
  "securityQuality",
  "documentation",
] as const;

/**
 * Validate the parsed judge payload: correct shape, integer scores, and — the
 * deterministic backstop — every score within its dimension's 0..max range.
 * With CLI-side schema enforcement removed, this is now the PRIMARY validation
 * ("never trust the judge"): an out-of-range or malformed score is a hard
 * failure rather than a silently inflated total. Pure function; unit-testable.
 */
export function parseJudgeResult(raw: unknown): JudgeResult {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Judge result is not an object.");
  }
  const obj = raw as Record<string, unknown>;

  const dim = (key: (typeof DIMENSION_KEYS)[number]) => {
    const max = DIMENSION_MAX[key];
    const d = obj[key];
    if (typeof d !== "object" || d === null) {
      throw new Error(`Judge result missing dimension "${key}".`);
    }
    const dd = d as Record<string, unknown>;
    const score = dd["score"];
    if (typeof score !== "number" || !Number.isInteger(score)) {
      throw new Error(`Judge dimension "${key}" has a non-integer score.`);
    }
    if (score < 0 || score > max) {
      throw new Error(
        `Judge dimension "${key}" score ${score} is out of range 0..${max}.`,
      );
    }
    if (typeof dd["justification"] !== "string") {
      throw new Error(`Judge dimension "${key}" missing justification.`);
    }
    return { score, justification: dd["justification"] };
  };

  // Summary is non-scoring narrative. The judge occasionally omits it; that must
  // never fail an otherwise-valid verdict (and never trigger a wasted retry), so
  // tolerate a missing/non-string summary by defaulting to empty.
  const summary = typeof obj["summary"] === "string" ? obj["summary"] : "";

  // securityReviewPerformed drives the (punitive) security cap. If present it
  // must be a boolean; if omitted, default to true so the cap only fires on a
  // positive "no review" signal (mirrors the tolerant summary handling).
  const srp = obj["securityReviewPerformed"];
  if (srp !== undefined && typeof srp !== "boolean") {
    throw new Error(
      `Judge result "securityReviewPerformed" must be a boolean if present.`,
    );
  }

  // taskSolved drives the (punitive) correctness cap on gated tasks. If present
  // it must be a boolean; leave it undefined when omitted so scoreRun applies
  // the default (true) — the cap only fires on a positive "unsolved" signal.
  const ts = obj["taskSolved"];
  if (ts !== undefined && typeof ts !== "boolean") {
    throw new Error(
      `Judge result "taskSolved" must be a boolean if present.`,
    );
  }

  return {
    codeQuality: dim("codeQuality"),
    testingCoverage: dim("testingCoverage"),
    securityQuality: dim("securityQuality"),
    documentation: dim("documentation"),
    securityReviewPerformed: srp === undefined ? true : srp,
    taskSolved: typeof ts === "boolean" ? ts : undefined,
    summary,
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
function extractJsonObjectText(text: string): string | null {
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

/**
 * Build an all-zero scored result for a run that could not be scored — either
 * the executor failed to produce output, or the judge failed to score it. The
 * failure kind is surfaced via executorFailure / judgeFailure so the report can
 * flag it. Deterministic caps still run (they only reduce, never inflate).
 */
export function buildFailureResult(
  artifacts: RunArtifacts,
  task: Task,
  failure: { executor?: string; judge?: string },
): VariantTaskResult {
  const reason = failure.executor ?? failure.judge ?? "unknown error";
  const kind = failure.judge ? "Judge" : "Executor";
  const zero = { score: 0, justification: `${kind} run failed; no output to score.` };
  const raw: JudgeResult = {
    codeQuality: zero,
    testingCoverage: zero,
    securityQuality: zero,
    documentation: zero,
    // A failed run is scored all-zero; the security cap ceiling (8) is above the
    // zero score, so this value is inert here regardless.
    securityReviewPerformed: false,
    // Inert: total is already 0, well under the correctness ceiling; kept
    // consistent so a gated failure reads the same as any other unsolved run.
    taskSolved: false,
    summary: `Run failed: ${reason}`,
  };
  const scored = scoreRun(raw, artifacts, task.meta);
  return {
    ...scored,
    ...(failure.executor ? { executorFailure: failure.executor } : {}),
    ...(failure.judge ? { judgeFailure: failure.judge } : {}),
  };
}

/**
 * Judge one run: build the evidence bundle, run the tool-less judge in a
 * container, parse + validate the JSON, then apply deterministic caps to
 * produce the final scored result.
 *
 * A failed executor short-circuits to an all-zero result (no judge quota spent).
 * A judge-side failure (container error, timeout, malformed/out-of-range output)
 * throws; the caller is responsible for catching it and recording a failed run
 * so one bad judge invocation never aborts the whole matrix.
 */
export async function judgeRun(
  artifacts: RunArtifacts,
  task: Task,
): Promise<VariantTaskResult> {
  if (!artifacts.executorOk) {
    return buildFailureResult(artifacts, task, {
      executor: artifacts.failureReason ?? "unknown error",
    });
  }

  // The diff/transcript are already node_modules-excluded and secret-redacted;
  // cap their size here so a legitimately huge diff can't blow the judge context.
  const diff = truncateEvidence(artifacts.diff, MAX_DIFF_BYTES, "diff");
  const transcript = truncateEvidence(
    artifacts.transcript,
    MAX_TRANSCRIPT_BYTES,
    "transcript",
  );
  const evidenceTruncated = diff.truncated || transcript.truncated;

  const judgePrompt = buildJudgePrompt({
    taskTitle: task.meta.title,
    taskPrompt: task.prompt,
    diff: diff.text,
    fileSummary: buildFileSummary(artifacts),
    transcript: transcript.text,
    successCriteria: task.meta.successCriteria,
  });

  // The judge is pure and idempotent, so retry on ANY failure — non-zero exit,
  // timeout, or output that lacks a valid JSON block / fails validation (a rare
  // blip now that turns=1 is reliable). Only if every attempt fails does the
  // composed error propagate to the caller's failure path.
  let parsed: JudgeResult;
  let judgeMetrics: CallMetrics | undefined;
  try {
    const { value } = await withRetry(
      async () => {
        const res = await runJudge({
          judgePrompt,
          model: JUDGE_MODEL,
        });
        if (res.exitCode !== 0 || res.timedOut) {
          throw new Error(
            `container exit ${res.exitCode}, timedOut=${res.timedOut}: ${res.stderr.slice(0, 300)}`,
          );
        }
        const verdict = parseJudgeResult(extractJudgeJson(res.stdout));
        // Judge metrics live on the CLI envelope (duration_ms/cost/usage), not
        // the inner JSON block. Capture the SUCCESSFUL attempt's metrics.
        let envelope: unknown = null;
        try {
          envelope = JSON.parse(res.stdout);
        } catch {
          /* keep envelope null → metrics degrade to wallMs-only */
        }
        judgeMetrics = parseCallMetrics(envelope, res.wallMs);
        return verdict;
      },
      {
        maxAttempts: JUDGE_MAX_ATTEMPTS,
        baseMs: RETRY_BASE_MS,
        onRetry: (failedAttempt, err) =>
          console.error(
            `  judge attempt ${failedAttempt + 1}/${JUDGE_MAX_ATTEMPTS} after failure: ${err.message.slice(0, 120)}`,
          ),
      },
    );
    parsed = value;
  } catch (err) {
    throw new Error(
      `Judge failed after ${JUDGE_MAX_ATTEMPTS} attempts: ${(err as Error).message}`,
    );
  }

  const scored = scoreRun(parsed, artifacts, task.meta);
  return {
    ...scored,
    metrics: judgeMetrics
      ? { ...scored.metrics, judge: judgeMetrics }
      : scored.metrics,
    ...(evidenceTruncated ? { evidenceTruncated } : {}),
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
