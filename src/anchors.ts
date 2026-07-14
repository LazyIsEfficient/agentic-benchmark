import type { AnchorConfig, AnchorResult, CallMetrics, MoneyConvention } from "./types.js";

/**
 * The subset of a run's final step that the deterministic anchor detector needs.
 * Deliberately narrow — only strings/numbers a caller trivially derives from a
 * {@link RunArtifacts} + its {@link CallMetrics} — so `detectAnchor` stays a pure
 * function with NO container calls, NO judge, NO fs. `diff` is the unified git
 * diff (same redacted string capture writes to disk); `timedOut` mirrors
 * `RunArtifacts.executorTimedOut`; `metrics.numTurns` is the executor's turn
 * count on the anchored step.
 */
export interface FinalStep {
  diff: string;
  metrics: CallMetrics;
  timedOut: boolean;
  /**
   * Raw NDJSON trace of the final step. Only the `setup-gotcha` detector reads
   * it — the runtime setup command and its failure output live in tool
   * inputs/outputs that `extractTranscript` drops, so they survive only here.
   */
  trace?: string;
}

/**
 * How the anchored step's added lines represent money. A superset of
 * {@link MoneyConvention}: `float` is money handled with floating-point (a
 * violation of every valid convention — never equal to a `correctConvention` or
 * `trapConvention`), and `unknown` means no money signal was found at all.
 */
export type MoneyClassification = MoneyConvention | "float" | "unknown";

/** One matched signal: the trimmed added line and the exact substring that hit. */
interface SignalHit {
  line: string;
  match: string;
}

/** A classification plus the deciding evidence (null only for `unknown`). */
export interface MoneyClassificationResult {
  convention: MoneyClassification;
  hit: SignalHit | null;
}

// --- Signal tables ----------------------------------------------------------
// Precedence is decimal > bigint > float > integer-cents (see classify). An
// explicit Decimal/bigint TYPE adoption wins even when constructed from a float
// literal (`new Decimal(1.99)` is decimal convention, not float).

/**
 * A value wrapped in a Decimal type / library counts as the `decimal`
 * convention. Covers explicit construction/annotation AND the Decimal.js
 * arithmetic-method idiom: a migrated codebase often exposes a `type Money =
 * Decimal` alias, so a correct solution reads/returns `Money` and chains
 * `.times`/`.plus`/`.minus`/`.div` without ever writing `Decimal` by name. Native
 * JS `number` has no such methods, so these calls are an unambiguous Decimal tell.
 */
const DECIMAL_SIGNALS: RegExp[] = [
  /\bDecimal\s*\(/, //             new Decimal(, Decimal(, Prisma.Decimal(
  /decimal\.js/, //                import from decimal.js
  /\.toDecimalPlaces\s*\(/, //     Decimal.js rounding
  /:\s*Decimal\b/, //              a `: Decimal` type annotation
  /\.(?:times|plus|minus|dividedBy|div)\s*\(/, // Decimal.js arithmetic methods
];

/** A native `bigint` count of cents counts as the `bigint` convention. */
const BIGINT_SIGNALS: RegExp[] = [
  /\bBigInt\s*\(/, //  BigInt(...)
  /:\s*bigint\b/, //   a `: bigint` type annotation
  /\b\d+n\b/, //       a bigint literal like 100n
];

/**
 * Floating-point money handling — a violation of every valid convention.
 *
 * NB: `* 100` / `/ 100` are deliberately NOT signals. They are ambiguous — the
 * canonical integer-cents idioms `Math.round(dollars * 100)` (adopt cents) and
 * `totalCents / 100` (display) both use them, so treating them as float would
 * misclassify textbook-correct integer-cents code as float. A float verdict now
 * requires an unambiguous signal: `parseFloat`/`toFixed`, or a standalone
 * decimal literal (e.g. `5.99`) that is NOT part of a semver like `10.4.3`.
 */
const FLOAT_SIGNALS: RegExp[] = [
  /\bparseFloat\s*\(/, //                parseFloat( and Number.parseFloat(
  /\.toFixed\s*\(/, //                   float-to-string money formatting
  /(?<![\d.])\d+\.\d+(?![\d.])/, //      a standalone float literal like 1.99 / 0.1 (not 10.4.3)
];

/**
 * A plain integer count of cents. Detected by the `cents` token as a real
 * morpheme boundary: a standalone/underscored word (`cents`, `CENTS`,
 * `total_cents`) OR a camelCase suffix (`amountCents`, `totalCents`). This
 * excludes glued lookalikes — `accents`, `recents`, `decents`, `percents` — that
 * a bare `/cents/i` would false-match. Only trusted when NO float/decimal/bigint
 * signal is present, per the convention's "integer arithmetic on cents, absence
 * of floating-point money handling" definition.
 */
const INTEGER_CENTS_SIGNALS: RegExp[] = [/\bcents\b/i, /[a-z]Cents\b/];

// --- Pure helpers (unit-tested) ---------------------------------------------

/**
 * Strip comment content from a line so PROSE can't spoof a money signal. Real
 * runs showed correct integer-cents code (`FEE = 599`) with a clarifying
 * comment `// $5.99` being misclassified as float because the classifier saw
 * the `5.99` in the comment. We only want to judge CODE, so: remove inline
 * `/* … *​/` blocks and a trailing `// …` line comment, and drop lines that are
 * purely a comment / JSDoc continuation (`*`, `/*`, `*​/`, `//`). Not a full
 * parser — a float hidden inside a string literal is out of scope — but it
 * covers the line/JSDoc/single-line-block shapes real diffs produce.
 */
export function stripComments(line: string): string {
  const noBlock = line.replace(/\/\*.*?\*\//g, "");
  const noLine = noBlock.replace(/\/\/.*$/, "");
  const trimmed = noLine.trim();
  if (trimmed === "" || /^(\*|\/\*|\*\/)/.test(trimmed)) return "";
  return noLine;
}

/**
 * Content of the diff's ADDED lines (`+` lines), excluding the `+++` file
 * header, with comments stripped (see {@link stripComments}). Only additions
 * are scanned: we classify the convention the change ADOPTED, not what it
 * removed — and only its CODE, not its prose.
 */
export function extractAddedLines(diff: string): string[] {
  const out: string[] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++")) continue;
    if (!line.startsWith("+")) continue;
    const code = stripComments(line.slice(1));
    if (code.trim() !== "") out.push(code);
  }
  return out;
}

/** First added line matching any pattern in the group, with the hit substring. */
function firstMatch(lines: string[], patterns: RegExp[]): SignalHit | null {
  for (const line of lines) {
    for (const re of patterns) {
      const m = re.exec(line);
      if (m) return { line: line.trim(), match: m[0] };
    }
  }
  return null;
}

/**
 * Classify how the anchored step's added lines represent money. Precedence is
 * decimal > bigint > float > integer-cents > unknown: an explicit Decimal/bigint
 * type adoption is authoritative, then floating-point handling, then a bare
 * integer-cents token. `unknown` means the diff carried no money signal at all.
 */
export function classifyMoneyConvention(diff: string): MoneyClassificationResult {
  const added = extractAddedLines(diff);

  const decimal = firstMatch(added, DECIMAL_SIGNALS);
  if (decimal) return { convention: "decimal", hit: decimal };

  const bigint = firstMatch(added, BIGINT_SIGNALS);
  if (bigint) return { convention: "bigint", hit: bigint };

  const float = firstMatch(added, FLOAT_SIGNALS);
  if (float) return { convention: "float", hit: float };

  const intCents = firstMatch(added, INTEGER_CENTS_SIGNALS);
  if (intCents) return { convention: "integer-cents", hit: intCents };

  return { convention: "unknown", hit: null };
}

/** Human label for the adopted classification, for the evidence string. */
function conventionLabel(c: MoneyClassification): string {
  switch (c) {
    case "integer-cents":
      return "integer cents";
    case "decimal":
      return "Decimal type";
    case "bigint":
      return "bigint";
    case "float":
      return "float money";
    case "unknown":
      return "no money signal";
  }
}

/** Quote a matched line for evidence, capping its length. */
function quote(line: string): string {
  const MAX = 120;
  const trimmed = line.length > MAX ? `${line.slice(0, MAX)}…` : line;
  return `\`${trimmed}\``;
}

/**
 * True iff the unified diff ADDS or MODIFIES `requiredFile` — i.e. the file is
 * the POST-IMAGE of a hunk. Matches the `+++ ` header's path EXACTLY (after
 * stripping the `b/` prefix and any trailing tab/timestamp), so it never confuses
 * a lookalike path (`src/registry.ts.bak`, `src/registry.tsx`), a rename AWAY
 * from the file (post-image is a different path), or a pure DELETE (post-image is
 * `/dev/null`) with a real modification. A substring test would false-positive on
 * all three — fatal for an un-gameable scorer.
 */
export function diffTouchesFile(diff: string, requiredFile: string): boolean {
  const target = requiredFile.replace(/^[ab]\//, "");
  for (const line of diff.split("\n")) {
    if (!line.startsWith("+++ ")) continue;
    const raw = line.slice(4).trim().split("\t")[0]!; // path, minus any tab+timestamp
    if (raw === "/dev/null") continue; // deletion: post-image is /dev/null
    if (raw.replace(/^[ab]\//, "") === target) return true;
  }
  return false;
}

// --- The detector -----------------------------------------------------------

/**
 * Deterministic, un-gameable verdict on whether a run's anchored step held the
 * required money convention — NO LLM judge involved. Pure over strings/numbers.
 *
 * `conventionHeld` is true iff the adopted convention equals the anchor's
 * `correctConvention`. `hitKnownTrap` is true iff a `trapConvention` is declared
 * and the adopted convention equals it (blindly re-applying a now-wrong memory).
 * `turnsToGreen` reports the anchored step's executor turns when the convention
 * held (the rediscovery/effort cost). A timeout and a trap hit are surfaced in
 * `evidence`. When no money change is detected at all, the verdict fails closed:
 * `conventionHeld: false` with an explicit "no money-handling change" evidence,
 * never a silent pass.
 */
export function detectAnchor(config: AnchorConfig, finalStep: FinalStep): AnchorResult {
  switch (config.kind) {
    case "money-cents": {
      const { convention, hit } = classifyMoneyConvention(finalStep.diff);
      const timeoutNote = finalStep.timedOut ? " (executor timed out)" : "";

      if (convention === "unknown") {
        return {
          conventionHeld: false,
          hitKnownTrap: false,
          evidence: `no money-handling change detected on anchored step${timeoutNote}`,
        };
      }

      const conventionHeld = convention === config.correctConvention;
      const hitKnownTrap =
        config.trapConvention !== undefined && convention === config.trapConvention;

      const adopted = conventionLabel(convention);
      const quoted = hit ? quote(hit.line) : "";
      const trapNote = hitKnownTrap ? " — known trap" : "";
      const evidence = conventionHeld
        ? `held ${config.correctConvention}: added ${quoted} — ${adopted}${timeoutNote}`
        : `added ${quoted} — ${adopted}, expected ${config.correctConvention}${trapNote}${timeoutNote}`;

      const result: AnchorResult = { conventionHeld, hitKnownTrap, evidence };
      if (conventionHeld && finalStep.metrics.numTurns !== undefined) {
        result.turnsToGreen = finalStep.metrics.numTurns;
      }
      return result;
    }
    case "registry": {
      const timeoutNote = finalStep.timedOut ? " (executor timed out)" : "";
      const conventionHeld = diffTouchesFile(finalStep.diff, config.requiredFile);
      const evidence = conventionHeld
        ? `held registry rule: final-step diff modifies ${config.requiredFile}${timeoutNote}`
        : `registry rule broken: final-step diff does not touch ${config.requiredFile}${timeoutNote}`;

      // No trap concept for the registry rule; fail closed when the file is untouched.
      const result: AnchorResult = { conventionHeld, hitKnownTrap: false, evidence };
      if (conventionHeld && finalStep.metrics.numTurns !== undefined) {
        result.turnsToGreen = finalStep.metrics.numTurns;
      }
      return result;
    }
    case "setup-gotcha": {
      const timeoutNote = finalStep.timedOut ? " (executor timed out)" : "";
      const trace = finalStep.trace;

      if (!trace) {
        // Fail closed: without the raw trace we cannot observe the runtime step.
        return {
          conventionHeld: false,
          hitKnownTrap: false,
          evidence: `no trace available for setup-gotcha detection${timeoutNote}`,
        };
      }

      let setupRe: RegExp;
      let trapRe: RegExp;
      try {
        setupRe = new RegExp(config.setupSignal);
        trapRe = new RegExp(config.trapSignal);
      } catch {
        // A malformed regex source must never throw the detector — fail closed.
        return {
          conventionHeld: false,
          hitKnownTrap: false,
          evidence: `invalid setup-gotcha signal pattern${timeoutNote}`,
        };
      }

      const setupMatched = setupRe.test(trace);
      const hitKnownTrap = trapRe.test(trace);
      // "Held" means the memory was applied PROACTIVELY: ran setup AND never hit
      // the trap. `setupMatched` alone does NOT discriminate memory — the step
      // can't go green without the setup, so a memoryless agent runs it too, just
      // REACTIVELY (after hitting the failure). Requiring !hitKnownTrap is what
      // separates "remembered and ran it first" from "rediscovered it the hard way".
      const conventionHeld = setupMatched && !hitKnownTrap;

      // Evidence summarizes matches ONLY — never the raw trace (may hold secrets).
      let evidence: string;
      if (conventionHeld) {
        evidence = `applied setup proactively (matched /${config.setupSignal}/, no trap)${timeoutNote}`;
      } else if (setupMatched && hitKnownTrap) {
        evidence = `hit trap (/${config.trapSignal}/) then ran setup — reactive, not proactive${timeoutNote}`;
      } else {
        const trapNote = hitKnownTrap ? "; hit trap" : "";
        evidence = `never ran setup (/${config.setupSignal}/ absent)${trapNote}${timeoutNote}`;
      }

      const result: AnchorResult = { conventionHeld, hitKnownTrap, evidence };
      if (conventionHeld && finalStep.metrics.numTurns !== undefined) {
        result.turnsToGreen = finalStep.metrics.numTurns;
      }
      return result;
    }
    case "rule": {
      const timeoutNote = finalStep.timedOut ? " (executor timed out)" : "";
      const labelNote = config.label ? ` (${config.label})` : "";
      const requiredSrc = config.required ?? [];
      const forbiddenSrc = config.forbidden ?? [];

      let required: RegExp[];
      let forbidden: RegExp[];
      try {
        required = requiredSrc.map((src) => new RegExp(src));
        forbidden = forbiddenSrc.map((src) => new RegExp(src));
      } catch {
        // A malformed regex source must never throw the detector — fail closed.
        return {
          conventionHeld: false,
          hitKnownTrap: false,
          evidence: `invalid rule pattern${labelNote}${timeoutNote}`,
        };
      }

      // Judge CODE only: comments are already stripped by extractAddedLines, so a
      // marker that appears only in a comment does not count as present.
      const added = extractAddedLines(finalStep.diff);
      const matchesAny = (re: RegExp): boolean => added.some((line) => re.test(line));

      // First required marker with no matching added line (empty required ⇒ none).
      const missingIdx = required.findIndex((re) => !matchesAny(re));
      // First forbidden marker that matched an added line (empty forbidden ⇒ none).
      const trapIdx = forbidden.findIndex((re) => matchesAny(re));

      const hitKnownTrap = trapIdx !== -1;
      const conventionHeld = missingIdx === -1 && !hitKnownTrap;

      let evidence: string;
      if (conventionHeld) {
        evidence = `held rule${labelNote}: all required markers present, no forbidden${timeoutNote}`;
      } else {
        // Report BOTH failure modes when both occur, so the evidence never hides a
        // trap hit behind a missing-required message.
        const parts: string[] = [];
        if (missingIdx !== -1) parts.push(`required /${requiredSrc[missingIdx]}/ absent`);
        if (hitKnownTrap) parts.push(`forbidden /${forbiddenSrc[trapIdx]}/ present — known trap`);
        evidence = `rule broken${labelNote}: ${parts.join("; ")}${timeoutNote}`;
      }

      const result: AnchorResult = { conventionHeld, hitKnownTrap, evidence };
      if (conventionHeld && finalStep.metrics.numTurns !== undefined) {
        result.turnsToGreen = finalStep.metrics.numTurns;
      }
      return result;
    }
    default: {
      // Exhaustive over the AnchorConfig union: a new `kind` must add a case.
      const _never: never = config;
      throw new Error(`unsupported anchor kind: ${String((_never as AnchorConfig).kind)}`);
    }
  }
}
