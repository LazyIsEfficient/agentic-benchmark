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
 * Content of the diff's ADDED lines (`+` lines), excluding the `+++` file
 * header. Only additions are scanned: we classify the convention the change
 * ADOPTED, not what it removed.
 */
export function extractAddedLines(diff: string): string[] {
  const out: string[] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++")) continue;
    if (line.startsWith("+")) out.push(line.slice(1));
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
    default: {
      // Exhaustive over the AnchorConfig union: a new `kind` must add a case.
      const _never: never = config.kind;
      throw new Error(`unsupported anchor kind: ${String(_never)}`);
    }
  }
}
