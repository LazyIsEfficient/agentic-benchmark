import type {
  AnchorConfig,
  AnchorGrade,
  AnchorResult,
  CallMetrics,
  MoneyConvention,
  RuleAnchor,
} from "./types.js";

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
 * required convention — NO LLM judge involved. Pure over strings/numbers.
 *
 * This is the INTERNAL grade-less detection engine: {@link detectAnchorGraded}
 * (the harness entry point) delegates to it for every non-`rule` anchor kind
 * and maps its booleans onto a grade. Exported so the per-kind detection logic
 * stays directly unit-testable.
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

// --- The graded detector ------------------------------------------------------

/** The two diff scopes a graded verdict is judged against. */
export interface GradedDiffs {
  /** The evaluated link's OWN unified diff (what THIS link changed). */
  linkDiff: string;
  /** Cumulative chain diff up to and including this link (campaign mode only). */
  cumulativeDiff?: string;
}

/** True iff the regex source compiles. Used to spot legacy fail-closed paths. */
function isValidRegExpSource(src: string): boolean {
  try {
    new RegExp(src);
    return true;
  } catch {
    return false;
  }
}

// --- Linkage-evidence harvesting (held-by-abstraction support) ----------------

/** Candidate identifiers for linkage evidence: 3+ chars, JS-identifier shaped. */
const LINKAGE_IDENTIFIER_RE = /[A-Za-z_$][\w$]{2,}/g;

/**
 * Half-height (in added CODE lines) of the linkage-harvest window around a
 * required-matching line. Widened from the original ±3 because the identifier
 * that carries an abstraction — a helper's NAME — sits on its DECLARATION line
 * (`function mintId()` / `const mintId =`), while the convention literal
 * (`ulid_`) lives further down in the helper BODY. A realistic id-minting helper
 * (signature → alphabet/loop → `return 'ulid_' + …`) puts those ~5-7 comment-
 * stripped lines apart, so a ±3 window silently dropped the name and degraded a
 * genuine ✓A hold to ✗ drift / ~C chain. ±10 spans a full such helper end-to-end
 * while staying well inside one function, so it never reaches an unrelated
 * declaration; the stoplist plus the "identifier must ALSO appear in the LINK
 * diff" gate keep the wider net from manufacturing false linkage.
 */
const LINKAGE_WINDOW = 10;

/** JS keywords / common tokens that can never serve as linkage evidence. */
const LINKAGE_STOPLIST: ReadonlySet<string> = new Set([
  "const", "let", "var", "function", "return", "export", "import", "new",
  "class", "type", "interface", "string", "number", "boolean", "true", "false",
  "null", "undefined", "async", "await", "this",
]);

/**
 * Added lines of a unified diff grouped by post-image file — same extraction as
 * {@link extractAddedLines} (comments stripped, blank/comment-only lines
 * dropped), but each `+++` header starts a new group so a linkage window can
 * never straddle a file boundary. Lines before the first header (headerless
 * fixture diffs) form their own group.
 */
function extractAddedLineGroups(diff: string): string[][] {
  const groups: string[][] = [];
  let current: string[] = [];
  const flush = (): void => {
    if (current.length > 0) groups.push(current);
    current = [];
  };
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++")) {
      flush();
      continue;
    }
    if (!line.startsWith("+")) continue;
    const code = stripComments(line.slice(1));
    if (code.trim() !== "") current.push(code);
  }
  flush();
  return groups;
}

/**
 * Harvest candidate linkage identifiers from a cumulative diff: for every added
 * line matching ANY `required` marker, collect the identifiers appearing within
 * ±{@link LINKAGE_WINDOW} added lines of it (same-file window, stoplist
 * excluded), deduplicated in first-seen order. These are the names an
 * abstraction built next to the marker plausibly travels under (e.g. the
 * helper's own name, which sits on its declaration line — above the literal in
 * the body); a later link consuming that abstraction re-emits one of them.
 */
function harvestLinkageIdentifiers(groups: string[][], required: RegExp[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const group of groups) {
    for (let i = 0; i < group.length; i++) {
      if (!required.some((re) => re.test(group[i]!))) continue;
      const lo = Math.max(0, i - LINKAGE_WINDOW);
      const hi = Math.min(group.length - 1, i + LINKAGE_WINDOW);
      for (let j = lo; j <= hi; j++) {
        for (const m of group[j]!.matchAll(LINKAGE_IDENTIFIER_RE)) {
          const ident = m[0]!;
          if (LINKAGE_STOPLIST.has(ident) || seen.has(ident)) continue;
          seen.add(ident);
          out.push(ident);
        }
      }
    }
  }
  return out;
}

/**
 * Map a legacy (non-rule) detector verdict onto an {@link AnchorGrade}. The
 * detection logic itself is untouched — this only refines the booleans:
 * held → `held-by-literal`, trap → `trap`, not-held-no-trap → `drift`, and the
 * detector's fail-closed INDETERMINATE paths (it could not observe, as opposed
 * to observing a break) → `unknown`. Registry has no indeterminate path: an
 * untouched `requiredFile` is a definite break, so it never grades `unknown`.
 */
function gradeFromLegacy(
  config: Exclude<AnchorConfig, RuleAnchor>,
  step: FinalStep,
  legacy: AnchorResult,
): AnchorGrade {
  if (legacy.hitKnownTrap) return "trap";
  if (legacy.conventionHeld) return "held-by-literal";
  switch (config.kind) {
    case "money-cents":
      if (classifyMoneyConvention(step.diff).convention === "unknown") return "unknown";
      break;
    case "setup-gotcha":
      if (!step.trace) return "unknown";
      if (!isValidRegExpSource(config.setupSignal) || !isValidRegExpSource(config.trapSignal)) {
        return "unknown";
      }
      break;
    case "registry":
      break;
  }
  return "drift";
}

/**
 * Graded verdict for the `rule` kind. Deterministic, evaluated in EXACT
 * precedence order over the diff's added lines (same extraction as the legacy
 * rule detector — comments stripped, `+` lines only):
 *
 *  1. any `forbidden` matches the LINK diff        → `trap`
 *  2. all `required` match the LINK diff           → `held-by-literal`
 *  3. `appliesIf` present, none match the LINK     → `held-by-inertia`
 *     (covers an EMPTY link diff when appliesIf is defined — vacuous hold)
 *  4. link diff has NO added lines                 → `unknown` (fail closed)
 *  5. all `required` match the CUMULATIVE diff (when provided) — a cumulative
 *     hold, adjudicated by LINK-LEVEL LINKAGE EVIDENCE. Candidate identifiers
 *     are harvested from the cumulative diff's added lines within
 *     ±LINKAGE_WINDOW lines of each required-matching line (same-file window,
 *     wide enough to reach a helper's declaration line from its body; 3+ chars, JS keywords /
 *     common tokens stoplisted); evidence = at least one harvested identifier
 *     appears in the link diff's added lines (e.g. a `generateId` helper built
 *     beside the `ulid_` marker earlier, and `generateId(` called here):
 *      a. linkage evidence found                   → `held-by-abstraction`
 *      b. no linkage, `appliesIf` defined          → `drift` (past rule 3, so
 *         the link EXERCISED the rule surface and did wrong-way work)
 *      c. no linkage, `appliesIf` NOT defined      → `held-by-chain` (the
 *         convention persists chain-wide but this link's applicability cannot
 *         be adjudicated; conventionHeld = true, honest weak label)
 *  6. otherwise                                    → `drift`
 *
 * Deliberate ordering notes:
 * - Inertia is checked BEFORE the cumulative hold so a link that never
 *   exercised the rule's surface isn't spuriously credited via the chain.
 * - Rule 4 precedes the cumulative hold: an empty link diff (no appliesIf to
 *   vouch for it) is ungradable and must NOT inherit a chain-level hold.
 * - `forbidden` is only ever tested against the LINK diff (rule 1). A
 *   forbidden marker inherited from an earlier link's cumulative diff does NOT
 *   poison this link's grade: per-link grading judges what THIS link did, not
 *   inherited sins. So forbidden-in-cumulative + required-in-link is still
 *   `held-by-literal`.
 * - An empty `required` is vacuously satisfied (existing rule semantics): a
 *   forbidden-only rule grades `held-by-literal` when clean.
 */
function detectRuleGraded(config: RuleAnchor, step: FinalStep, diffs: GradedDiffs): AnchorResult {
  const timeoutNote = step.timedOut ? " (executor timed out)" : "";
  const labelNote = config.label ? ` (${config.label})` : "";
  const requiredSrc = config.required ?? [];
  const forbiddenSrc = config.forbidden ?? [];
  const appliesIfSrc = config.appliesIf;

  const broke = (grade: "trap" | "drift" | "unknown", detail: string): AnchorResult => ({
    conventionHeld: false,
    hitKnownTrap: grade === "trap",
    grade,
    evidence: `${grade}${labelNote}: ${detail}${timeoutNote}`,
  });
  const held = (
    grade: "held-by-literal" | "held-by-inertia" | "held-by-abstraction" | "held-by-chain",
    detail: string,
  ): AnchorResult => {
    const result: AnchorResult = {
      conventionHeld: true,
      hitKnownTrap: false,
      grade,
      evidence: `${grade}${labelNote}: ${detail}${timeoutNote}`,
    };
    if (step.metrics.numTurns !== undefined) result.turnsToGreen = step.metrics.numTurns;
    return result;
  };

  let required: RegExp[];
  let forbidden: RegExp[];
  let appliesIf: RegExp[] | undefined;
  try {
    required = requiredSrc.map((src) => new RegExp(src));
    forbidden = forbiddenSrc.map((src) => new RegExp(src));
    appliesIf = appliesIfSrc?.map((src) => new RegExp(src));
  } catch {
    // A malformed regex source must never throw the detector — fail closed.
    return broke("unknown", "invalid rule pattern — cannot grade");
  }

  const linkAdded = extractAddedLines(diffs.linkDiff);
  const matchesLink = (re: RegExp): boolean => linkAdded.some((line) => re.test(line));

  // 1. A forbidden marker in the link's own diff is the trap, full stop.
  const trapIdx = forbidden.findIndex(matchesLink);
  if (trapIdx !== -1) {
    return broke("trap", `forbidden /${forbiddenSrc[trapIdx]}/ matched link-diff added lines`);
  }

  // 2. All required markers re-emitted literally in this link.
  const missingIdx = required.findIndex((re) => !matchesLink(re));
  if (missingIdx === -1) {
    const detail =
      requiredSrc.length === 0
        ? "no required markers (vacuously satisfied), no forbidden matched link diff"
        : `all required (${requiredSrc.map((s) => `/${s}/`).join(", ")}) matched link-diff added lines`;
    return held("held-by-literal", detail);
  }

  // 3. The link never exercised the rule's surface — a vacuous hold.
  if (appliesIf !== undefined && !appliesIf.some(matchesLink)) {
    const patterns = (appliesIfSrc ?? []).map((s) => `/${s}/`).join(", ");
    return held(
      "held-by-inertia",
      `no appliesIf (${patterns}) matched link diff — rule never exercised by this link`,
    );
  }

  // 4. No added code at all is ungradable — fail closed BEFORE the cumulative
  // hold, so an empty link can never inherit a chain-level grade.
  if (linkAdded.length === 0) {
    return broke("unknown", "link diff has no added lines — nothing to grade");
  }

  // 5. The convention persists cumulatively (e.g. a helper built in a prior
  // link) — but a cumulative hold needs LINK-LEVEL linkage evidence to earn
  // `held-by-abstraction`; without it the grade degrades to drift (surface
  // exercised, wrong-way work) or held-by-chain (applicability unknowable).
  if (diffs.cumulativeDiff !== undefined) {
    const cumulativeGroups = extractAddedLineGroups(diffs.cumulativeDiff);
    const cumulativeAdded = cumulativeGroups.flat();
    const matchesCumulative = (re: RegExp): boolean => cumulativeAdded.some((line) => re.test(line));
    if (required.every(matchesCumulative)) {
      const candidates = harvestLinkageIdentifiers(cumulativeGroups, required);
      const linkage = candidates.find((ident) => linkAdded.some((line) => line.includes(ident)));
      if (linkage !== undefined) {
        return held(
          "held-by-abstraction",
          `required /${requiredSrc[missingIdx]}/ absent from link diff but all required matched cumulative-diff added lines; linkage via identifier "${linkage}" reused in this link's diff`,
        );
      }
      if (appliesIf !== undefined) {
        return broke(
          "drift",
          `required /${requiredSrc[missingIdx]}/ absent from link diff; cumulative markers exist but no linkage identifier appears in this link's diff, and the link exercised the rule surface (appliesIf matched)`,
        );
      }
      return held(
        "held-by-chain",
        `all required matched cumulative-diff added lines but no linkage identifier appears in this link's diff; applicability unknown (no appliesIf)`,
      );
    }
  }

  // 6. Real added code without the convention is drift.
  const cumulativeNote = diffs.cumulativeDiff !== undefined ? " and cumulative diff" : "";
  return broke("drift", `required /${requiredSrc[missingIdx]}/ absent from link diff${cumulativeNote}`);
}

/**
 * Graded refinement of {@link detectAnchor}: same deterministic, judge-free
 * contract, but the returned {@link AnchorResult} ALWAYS carries a `grade`
 * distinguishing HOW the convention held (abstraction > literal > inertia >
 * chain > drift > trap; `unknown` fails closed). Only the `rule` kind consumes the
 * link/cumulative diff split (see {@link detectRuleGraded}); every other kind
 * runs the grade-less {@link detectAnchor} engine against `step` unchanged and
 * maps its booleans onto a grade ({@link gradeFromLegacy}), so their boolean
 * fields are byte-identical to `detectAnchor`'s.
 */
export function detectAnchorGraded(
  config: AnchorConfig,
  step: FinalStep,
  diffs: GradedDiffs,
): AnchorResult {
  if (config.kind === "rule") return detectRuleGraded(config, step, diffs);
  const legacy = detectAnchor(config, step);
  return { ...legacy, grade: gradeFromLegacy(config, step, legacy) };
}
