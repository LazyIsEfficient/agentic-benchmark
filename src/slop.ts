import { isDocFile } from "./surface.js";
import type { SlopMetrics } from "./types.js";

/**
 * Deterministic "slop" metrics over a unified git diff — the mechanical half of
 * the Craft axis. Every function here is pure over strings (no fs, no
 * containers, no judge) so the numbers can neither be argued with nor fudged:
 * the LLM judge scores only the qualitative residual, and a reader can
 * re-derive any count from the diff by hand. Definitions are deliberately
 * conservative — a metric that false-positives on ordinary code would punish
 * good runs, which is worse than missing some slop.
 */

// --- Tunables ------------------------------------------------------------------

/** Duplication window length: 4 lines ≈ the smallest copy-paste worth flagging. */
const DUP_WINDOW_LINES = 4;
/**
 * A window needs ≥3 non-empty lines AND ≥40 significant (non-whitespace) chars
 * to be eligible. Both filters exist to keep brace/import/blank-line noise —
 * which repeats in ANY healthy diff — from counting as duplication.
 */
const DUP_MIN_NON_EMPTY_LINES = 3;
const DUP_MIN_SIGNIFICANT_CHARS = 40;
/** Evidence is capped so a pathological diff can't flood the report payload. */
const TAMPER_EVIDENCE_MAX = 10;
/** Max chars of a quoted line excerpt in tamper evidence. */
const TAMPER_EXCERPT_MAX_CHARS = 80;
/** Distinct duplicated windows cited as evidence — capped like tamper evidence. */
const DUP_EVIDENCE_MAX = 10;
/** Max chars of a quoted (multi-line) duplicated-window excerpt. */
const DUP_EXCERPT_MAX_CHARS = 200;

// --- Diff line extraction --------------------------------------------------------

/**
 * The diff's ADDED lines (`+` lines, minus the `+++` file headers), RAW — only
 * the leading `+` is stripped. Unlike anchors' extractAddedLines this keeps
 * comments, whitespace, and blank lines: slop metrics judge everything a run
 * shipped, prose included (a TODO in a comment is exactly the residue we
 * count). Exported because the campaign runner accumulates earlier links'
 * added lines with it and feeds them back as `earlierAddedLines`.
 */
export function addedLines(diff: string): string[] {
  const out: string[] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++")) continue;
    if (line.startsWith("+")) out.push(line.slice(1));
  }
  return out;
}

/**
 * The diff's REMOVED lines (`-` lines, minus the `---` file headers), RAW —
 * only the leading `-` is stripped. Removed lines feed churnRatio (deleting
 * your own earlier work) and the deleted-assertion tamper signal.
 */
export function removedLines(diff: string): string[] {
  const out: string[] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("---")) continue;
    if (line.startsWith("-")) out.push(line.slice(1));
  }
  return out;
}

/**
 * The new-file path a `+++` header names, `b/`-prefix stripped and any trailing
 * `\t`-delimited metadata dropped. null for `/dev/null` (a deletion) or an
 * unparseable header. Only `+++` is parsed — every git file section that can
 * carry ADDED lines emits one, so it is the reliable path source.
 */
function fileFromPlusHeader(line: string): string | null {
  const rest = (line.slice(3).split("\t")[0] ?? "").trim();
  if (rest === "" || rest === "/dev/null") return null;
  return rest.replace(/^[ab]\//, "");
}

/**
 * Added lines grouped per changed file — each group tagged with its path so
 * doc/test files can be excluded from production-code metrics — and so
 * duplication windows can never straddle a file boundary (4 lines that only
 * line up when two files are concatenated are not a copy-paste). A `diff --git`
 * or `+++` header starts a new group; the path comes from `+++`. Lines before
 * any header land in an implicit first group (`file: null`) so header-less
 * fixture diffs still work — a null path is treated as production code.
 */
function addedLinesByFile(diff: string): { file: string | null; lines: string[] }[] {
  const groups: { file: string | null; lines: string[] }[] = [];
  let currentFile: string | null = null;
  let current: string[] = [];
  const flush = (): void => {
    if (current.length > 0) groups.push({ file: currentFile, lines: current });
    current = [];
  };
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      currentFile = null; // the following +++ header sets the real path
      continue;
    }
    if (line.startsWith("+++")) {
      flush();
      currentFile = fileFromPlusHeader(line);
      continue;
    }
    if (line.startsWith("+")) current.push(line.slice(1));
  }
  flush();
  return groups;
}

/**
 * True when a path is a TEST file: its filename carries a `.test.`/`.spec.`
 * infix, OR any path segment is `test`/`tests`/`__tests__`. Path-based and
 * case-insensitive (no fs, no content read), mirroring {@link isDocFile}.
 * WHY: the production-code-hygiene metrics (duplication, residue,
 * literalDensity, helperReuse) must not PENALIZE the thoroughness — extra
 * tests and docs — the Craft judge REWARDS (issue #43). testTamper is the
 * deliberate exception: it operates ON test files and keeps counting them.
 *
 * NOTE: a bare `spec` PATH SEGMENT is deliberately NOT matched — a production
 * `spec/` directory (OpenAPI / JSON-schema / API specs) is real code whose slop
 * must stay measured. The `.spec.` INFIX (`foo.spec.ts`) is unambiguously a
 * test file and IS matched. Under-matching (missing e.g. `foo_test.go`,
 * `test_foo.py`) is the safe direction for a TS harness — a missed test file
 * only leaves it measured, never wrongly excludes production code.
 */
export function isTestFile(path: string): boolean {
  const lower = path.toLowerCase();
  const filename = lower.slice(lower.lastIndexOf("/") + 1);
  if (filename.includes(".test.") || filename.includes(".spec.")) return true;
  return lower
    .split("/")
    .some((seg) => seg === "test" || seg === "tests" || seg === "__tests__");
}

/**
 * Filenames of GENERATED dependency lockfiles across the JS ecosystem — matched
 * on the basename only, case-insensitively. These are regenerated by the package
 * manager (`npm install` etc.), never hand-authored, so their inherently
 * repetitive dependency entries are not the agent's craft: hundreds of
 * near-identical windows would otherwise tank duplication for any run that added
 * a dependency (issue #45). Mirrors blast-radius, which already treats a
 * lockfile edit as `defensible`, not overreach. `package.json`/`tsconfig.json`
 * are deliberately NOT here — those are authored and stay counted.
 */
const GENERATED_LOCKFILES = new Set<string>([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
]);

/** True when a path is a generated dependency lockfile (basename match, case-insensitive). */
export function isGeneratedFile(path: string): boolean {
  const lower = path.toLowerCase();
  const filename = lower.slice(lower.lastIndexOf("/") + 1);
  return GENERATED_LOCKFILES.has(filename);
}

/**
 * True when a file is excluded from production-code metrics: a doc, test, or
 * generated (lockfile) file — none is agent-authored production craft.
 */
function isNonProductionFile(file: string | null): boolean {
  return file !== null && (isDocFile(file) || isTestFile(file) || isGeneratedFile(file));
}

/**
 * Added lines from PRODUCTION files only — doc and test files dropped. The flat
 * input to the code-hygiene metrics (residue, literalDensity, helperReuse) so
 * they grade only shipped production code, never the tests/docs the Craft judge
 * rewards separately (issue #43).
 */
function productionAddedLines(diff: string): string[] {
  const out: string[] = [];
  for (const group of addedLinesByFile(diff)) {
    if (isNonProductionFile(group.file)) continue;
    out.push(...group.lines);
  }
  return out;
}

// --- duplicationDelta ------------------------------------------------------------

/**
 * Normalize a line for duplication comparison: trim, collapse internal
 * whitespace runs to single spaces. WHY: copy-paste usually survives
 * re-indentation, so indentation must not hide a duplicate — but we do NOT
 * strip identifiers or punctuation, because "similar" is the judge's call;
 * this metric only counts the mechanically identical.
 */
function normalizeForDuplication(line: string): string {
  return line.trim().replace(/\s+/g, " ");
}

/** One duplicated window quoted for audit: the file it first appeared in + a capped excerpt. */
type DuplicationEvidence = SlopMetrics["duplicationEvidence"];

/**
 * Count of duplicated added-line windows, plus per-file evidence. Per changed
 * PRODUCTION file (doc/test files are skipped — issue #43): slide a
 * {@link DUP_WINDOW_LINES}-line window over that file's normalized added lines
 * (in order); skip windows below the non-empty / significant-char floors; then
 * count, across the whole PRODUCTION diff, every extra occurrence of an
 * identical window (N identical windows → N−1). WHY windows and not whole
 * functions: a 4-consecutive-line exact match is the smallest unit that is
 * almost never coincidental once brace/import noise is filtered out, and it
 * needs no parser.
 *
 * Evidence mirrors testTamper's: a capped ({@link DUP_EVIDENCE_MAX}) array of
 * {file, excerpt} for the windows that actually repeated, so the count is
 * auditable — a reader can tell repetitive production bloat from a
 * false-positive without re-deriving the whole diff.
 */
function duplicationDelta(diff: string): { count: number; evidence: DuplicationEvidence } {
  const occurrences = new Map<string, { count: number; file: string; window: string[] }>();
  for (const group of addedLinesByFile(diff)) {
    if (isNonProductionFile(group.file)) continue;
    const normalized = group.lines.map(normalizeForDuplication);
    for (let i = 0; i + DUP_WINDOW_LINES <= normalized.length; i++) {
      const window = normalized.slice(i, i + DUP_WINDOW_LINES);
      const nonEmpty = window.filter((l) => l !== "").length;
      if (nonEmpty < DUP_MIN_NON_EMPTY_LINES) continue;
      const significantChars = window.reduce(
        (n, l) => n + l.replace(/\s/g, "").length,
        0,
      );
      if (significantChars < DUP_MIN_SIGNIFICANT_CHARS) continue;
      const key = window.join("\n");
      const existing = occurrences.get(key);
      if (existing !== undefined) existing.count++;
      else occurrences.set(key, { count: 1, file: group.file ?? "(unknown)", window });
    }
  }
  let count = 0;
  const evidence: { file: string; excerpt: string }[] = [];
  for (const occ of occurrences.values()) {
    if (occ.count <= 1) continue;
    count += occ.count - 1;
    if (evidence.length < DUP_EVIDENCE_MAX) {
      evidence.push({ file: occ.file, excerpt: excerptWindow(occ.window) });
    }
  }
  return { count, evidence };
}

/** Quote a duplicated window for evidence: non-empty lines joined, capped at {@link DUP_EXCERPT_MAX_CHARS}. */
function excerptWindow(window: string[]): string {
  const joined = window
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .join(" / ");
  return joined.length > DUP_EXCERPT_MAX_CHARS ? joined.slice(0, DUP_EXCERPT_MAX_CHARS) : joined;
}

// --- churnRatio --------------------------------------------------------------------

/**
 * Fraction of the chain's earlier added lines that THIS diff deletes — how much
 * of its OWN prior work the agent is rewriting across a campaign. null when
 * there is no earlier work (single-shot cells): 0 would falsely read as
 * "measured and clean". Matching is multiset-style — each earlier line is
 * consumable once — so removing a line twice can't out-count how often it was
 * ever added, keeping the ratio in [0,1]. Lines are trim-normalized only (no
 * whitespace collapse: a re-indent that keeps the line is not a deletion of
 * it... it IS still a match after trim; deeper rewrites won't match and count
 * as churn only via the lines actually removed). Blank lines are excluded from
 * matching — a deleted blank line says nothing about churning real work — but
 * the denominator stays `earlierAddedLines.length` as defined.
 */
function computeChurnRatio(
  removed: string[],
  earlierAddedLines: string[] | undefined,
): number | null {
  if (earlierAddedLines === undefined || earlierAddedLines.length === 0) return null;
  const pool = new Map<string, number>();
  for (const line of earlierAddedLines) {
    const t = line.trim();
    if (t === "") continue;
    pool.set(t, (pool.get(t) ?? 0) + 1);
  }
  let matched = 0;
  for (const line of removed) {
    const t = line.trim();
    if (t === "") continue;
    const remaining = pool.get(t);
    if (remaining !== undefined && remaining > 0) {
      pool.set(t, remaining - 1);
      matched++;
    }
  }
  return matched / earlierAddedLines.length;
}

// --- residue -------------------------------------------------------------------------

/** Work-in-progress markers an agent should have resolved before shipping. */
const TODO_SIGNAL = /\b(TODO|FIXME|XXX|HACK)\b/;

/** Debug output left in the diff: console.log/debug/trace or a debugger statement. */
const DEBUG_LOGGING_SIGNAL = /console\.(log|debug|trace)\s*\(|(^|\s)debugger\b/;

/** A comment line: trimmed text starting with `//`, `*` (JSDoc body), or `/*`. */
const COMMENT_MARKER = /^(?:\/\/+|\/\*+|\*+)\s*(.*)$/;

/**
 * Comment TEXT that looks like disabled CODE rather than prose. Conservative
 * by design — an English sentence mentioning `return` must not count — so a
 * hit requires code punctuation: a `;`/`{`/`}` line ending, a statement
 * keyword followed by `;` or `)`, or an arrow. Prose almost never ends in a
 * semicolon or carries `=>`; commented-out code almost always does.
 */
const CODE_LIKE_SIGNALS: RegExp[] = [
  /[;{}]\s*$/,
  /\b(return|const|let|var|await|import|require)\b.*[;)]/,
  /=>/,
];

/**
 * Leftover work-in-progress artifacts in the ADDED lines only. WHY added-only:
 * residue measures what the run SHIPPED — a TODO in a removed or context line
 * is pre-existing debt, not this run's slop. Each counter counts matching
 * LINES (a line with two TODOs is one line of residue).
 */
function countResidue(added: string[]): SlopMetrics["residue"] {
  let todos = 0;
  let debugLogging = 0;
  let commentedOutCode = 0;
  for (const line of added) {
    if (TODO_SIGNAL.test(line)) todos++;
    if (DEBUG_LOGGING_SIGNAL.test(line)) debugLogging++;
    const marker = COMMENT_MARKER.exec(line.trim());
    if (marker !== null) {
      const text = marker[1] ?? "";
      if (CODE_LIKE_SIGNALS.some((re) => re.test(text))) commentedOutCode++;
    }
  }
  return { todos, debugLogging, commentedOutCode };
}

// --- helperReuse -----------------------------------------------------------------------

/**
 * Names DECLARED as a reusable helper on an added line: a `function foo(`, a
 * `const foo = (…) =>` / `const foo = x =>` arrow, or a `const foo = function`
 * expression (also `let`/`var`, with optional `export`/`async`). The negative
 * lookbehind keeps `obj.foo` / `a_foo` from matching. WHY only these forms: they
 * are the syntactic shapes an agent uses when it EXTRACTS shared logic — the
 * thing whose reuse we want to reward.
 */
const FUNCTION_DECL = /(?<![\w$.])(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/;
const ARROW_OR_FN_EXPR_DECL =
  /(?<![\w$.])(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/;

/** Identifier chars need no regex escaping, but be explicit for the dynamic call regex. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Helper-extraction signal: total call-sites in the ADDED lines that REUSE a
 * helper the SAME diff declares. Collect every declared helper name, then count
 * `name(` call tokens across all added lines and subtract the one spurious token
 * a `function name(` declaration contributes to its own name (arrow/expression
 * declarations write `name =`, not `name(`, so they self-count as zero). A helper
 * defined but never called scores 0; a helper called from N sites scores N. WHY
 * declared-only: counting arbitrary `foo(` calls would reward ordinary library
 * use and punish nothing — the metric must isolate the run's OWN extraction.
 */
function helperReuseCount(added: string[]): number {
  const declared = new Set<string>();
  const functionDeclCount = new Map<string, number>();
  for (const line of added) {
    const arrow = ARROW_OR_FN_EXPR_DECL.exec(line);
    if (arrow !== null) declared.add(arrow[1]!);
    const fn = FUNCTION_DECL.exec(line);
    if (fn !== null) {
      const name = fn[1]!;
      declared.add(name);
      functionDeclCount.set(name, (functionDeclCount.get(name) ?? 0) + 1);
    }
  }
  if (declared.size === 0) return 0;
  let reused = 0;
  for (const name of declared) {
    const callRe = new RegExp(`(?<![\\w$.])${escapeRegExp(name)}\\s*\\(`, "g");
    let calls = 0;
    for (const line of added) calls += (line.match(callRe) ?? []).length;
    calls -= functionDeclCount.get(name) ?? 0; // the declaration's own `name(` is not a call
    if (calls > 0) reused += calls;
  }
  return reused;
}

// --- literalDensity --------------------------------------------------------------------

/**
 * A declaration whose ENTIRE right-hand side is a single literal —
 * `const NAME = 3600;` / `const LABEL = "svc";` (optional type annotation,
 * optional leading `-`, optional trailing `;`). This is the HEALTHY extraction
 * (naming a magic value), so its literal is not slop. A COMPOUND RHS
 * (`const delay = elapsed * 1000 + 250`) does NOT match — its inlined literals
 * still count. Skipping only the single-literal form keeps the metric from
 * crediting expression-buried literals as "extracted".
 */
const SIMPLE_CONSTANT_DECL =
  /^(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*(?::[^=]+)?=\s*(?:-?\d[\d_]*(?:\.\d+)?|(['"`])(?:\\.|(?!\1).)*\1)\s*;?\s*$/;
/** An import / re-export line — module specifiers are not magic literals. */
const MODULE_LINE = /^(?:import\b|export\s+.*\bfrom\b)|require\s*\(/;
/** A quoted string literal (single/double/backtick), escapes tolerated. */
const STRING_LITERAL = /(['"`])(?:\\.|(?!\1).)*\1/g;
/** A numeric literal not glued to an identifier/dot (so `a1`/`x.5` don't match), digit-group underscores allowed. */
const NUMERIC_LITERAL = /(?<![\w$.])\d[\d_]*(?:\.\d+)?(?![\w$.])/g;

/** Count magic string literals on a line: inner length ≥2 and not a `${}` template. */
function countMagicStrings(line: string): number {
  let n = 0;
  for (const m of line.matchAll(STRING_LITERAL)) {
    const inner = m[0].slice(1, -1);
    if (inner.length >= 2 && !inner.includes("${")) n++;
  }
  return n;
}

/** Count magic numeric literals on a string-stripped line: skip single-digit ints (0–9). */
function countMagicNumbers(lineWithoutStrings: string): number {
  let n = 0;
  for (const m of lineWithoutStrings.matchAll(NUMERIC_LITERAL)) {
    const raw = m[0].replace(/_/g, "");
    if (/^\d$/.test(raw)) continue; // single-digit integer: too common to be "magic"
    n++;
  }
  return n;
}

/**
 * Literal-density signal: magic literals INLINED in added code. Skips blank,
 * comment, import, and named-constant-declaration lines (defining a `const NAME`
 * is the extraction we want, not slop). On surviving lines, count non-trivial
 * string literals, then count numeric literals in the string-stripped remainder
 * so digits inside a string never double-count. Conservative floors (empty/1-char
 * strings, single-digit ints) keep ordinary code from scoring; the metric is
 * meant to separate inline-literal drift from constant extraction, nothing finer.
 */
function literalDensityCount(added: string[]): number {
  let count = 0;
  for (const raw of added) {
    const line = raw.trim();
    if (line === "") continue;
    if (COMMENT_MARKER.test(line)) continue;
    if (MODULE_LINE.test(line)) continue;
    if (SIMPLE_CONSTANT_DECL.test(line)) continue;
    count += countMagicStrings(line);
    count += countMagicNumbers(line.replace(STRING_LITERAL, " "));
  }
  return count;
}

// --- testTamper -----------------------------------------------------------------------

/**
 * Signals in an ADDED line that weaken the test suite: skipped/focused
 * tests (`.skip(`/`.only(`/`xit(`/`xdescribe(`/`test.todo(`), silenced linting
 * (`eslint-disable`), silenced typechecking (`@ts-nocheck`), and a runner told
 * that zero tests is fine (`--passWithNoTests`). Substring semantics, except
 * the bare-global jasmine forms (`xit(`/`xdescribe(`) which require an
 * identifier boundary — otherwise every `process.exit(0)` would count as a
 * skipped test. Evidence keeps the literal token as the signal name so a
 * verdict stays re-derivable by hand.
 */
const ADDED_TAMPER_SIGNALS: { name: string; re: RegExp }[] = [
  { name: ".skip(", re: /\.skip\(/ },
  { name: ".only(", re: /\.only\(/ },
  { name: "xit(", re: /(?<![\w$.])xit\(/ },
  { name: "xdescribe(", re: /(?<![\w$.])xdescribe\(/ },
  { name: "test.todo(", re: /test\.todo\(/ },
  { name: "eslint-disable", re: /eslint-disable/ },
  { name: "@ts-nocheck", re: /@ts-nocheck/ },
  { name: "--passWithNoTests", re: /--passWithNoTests/ },
];

/** A REMOVED line containing any of these deleted an assertion. */
const DELETED_ASSERTION_TOKENS: string[] = ["expect(", "assert.", "assert("];

/** Whether a line carries an assertion token — the long-standing substring test. */
function hasAssertionToken(line: string): boolean {
  return DELETED_ASSERTION_TOKENS.some((token) => line.includes(token));
}

/**
 * Matches an assertion CALLEE and its opening paren: `expect(`, `assert(`, or a
 * dotted `assert.deepEqual(` / `assert.strictEqual(` chain. The negative
 * lookbehind keeps `foo.assert(` / `myexpect(` from matching, mirroring the
 * `xit(` boundary rule.
 */
const ASSERTION_CALLEE = /(?<![\w$.])(expect|assert(?:\.[A-Za-z_$][\w$]*)*)\s*\(/;

/**
 * A stable "shape" for an assertion line: its callee chain plus the FIRST
 * (balanced) argument — the SUBJECT under test — whitespace-collapsed; the
 * EXPECTED value (later args / object body) is deliberately excluded. WHY: when
 * a task changes a data shape (e.g. adds a `createdAt` field), agents must
 * REWRITE existing assertions — the expected value changes but the subject does
 * not, so a delete + re-add of the same assertion share a shape and net to
 * zero. Returns null when no assertion callee is found; the caller then treats
 * a removal as a real, unmatched deletion.
 *
 * KNOWN BLIND SPOT (deliberate): because the shape excludes the expected value,
 * a value-WEAKENING rewrite of the same subject — delete
 * `assert.deepEqual(x, STRONG)`, add `assert.deepEqual(x, WEAK)` — also nets to
 * zero and goes undetected. This is an accepted tradeoff: including the expected
 * value would re-introduce the false positive on every legitimate expected-value
 * update (the exact bug this fix removed), and the metric is intentionally
 * conservative — a false positive on ordinary code is worse than missing some
 * slop. Weakened-value tampering is left for the qualitative judge to catch.
 */
function assertionShape(line: string): string | null {
  const m = ASSERTION_CALLEE.exec(line);
  if (m === null) return null;
  const callee = m[1] ?? "";
  const openIdx = m.index + m[0].length - 1; // index of the '('
  let depth = 0;
  let subject = "";
  for (let i = openIdx; i < line.length; i++) {
    const ch = line[i]!;
    if (i === openIdx) {
      depth = 1;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) break; // the assertion call closed
    }
    if (depth === 1 && ch === ",") break; // end of the first argument
    subject += ch;
  }
  return `${callee}(${subject.trim().replace(/\s+/g, " ")})`;
}

/**
 * Signals that the run weakened tests to pass. Scans BOTH sides of the diff:
 * added lines for the tamper substrings above, removed lines for deleted
 * assertions — deleting `expect(...)` is the quietest way to turn a suite
 * green. Each matching line counts once PER SIGNAL it matches (a line that
 * both `.skip(`s and `.only(`s is two hits).
 *
 * The deleted-assertion signal counts only a NET assertion loss: a removed
 * assertion whose {@link assertionShape} is matched by a re-added assertion is
 * a rewrite (the task forced the expected value to change), not tampering, and
 * nets to zero. Shapes are consumed once each (multiset) so removing two and
 * re-adding one still flags the single net deletion. A removed assertion with
 * no matching re-addition is one hit no matter how many assertion tokens it
 * holds. Evidence quotes up to {@link TAMPER_EVIDENCE_MAX} offending lines so
 * the verdict stays auditable without republishing the diff.
 */
function detectTestTamper(added: string[], removed: string[]): SlopMetrics["testTamper"] {
  let hits = 0;
  const evidence: string[] = [];
  const record = (signal: string, line: string): void => {
    hits++;
    if (evidence.length < TAMPER_EVIDENCE_MAX) {
      evidence.push(`${signal}: ${excerpt(line)}`);
    }
  };
  for (const line of added) {
    for (const signal of ADDED_TAMPER_SIGNALS) {
      if (signal.re.test(line)) record(signal.name, line);
    }
  }
  const readdedShapes = new Map<string, number>();
  for (const line of added) {
    const shape = assertionShape(line);
    if (shape !== null) readdedShapes.set(shape, (readdedShapes.get(shape) ?? 0) + 1);
  }
  for (const line of removed) {
    if (!hasAssertionToken(line)) continue;
    const shape = assertionShape(line);
    if (shape !== null) {
      const remaining = readdedShapes.get(shape);
      if (remaining !== undefined && remaining > 0) {
        readdedShapes.set(shape, remaining - 1); // rewrite: nets to zero
        continue;
      }
    }
    record("deleted-assertion", line);
  }
  return { hits, evidence };
}

/** Quote a line for evidence: trimmed, capped at {@link TAMPER_EXCERPT_MAX_CHARS}. */
function excerpt(line: string): string {
  const trimmed = line.trim();
  return trimmed.length > TAMPER_EXCERPT_MAX_CHARS
    ? trimmed.slice(0, TAMPER_EXCERPT_MAX_CHARS)
    : trimmed;
}

// --- The metric bundle -------------------------------------------------------------------

/**
 * Compute all mechanical slop metrics for one run's diff. `earlierAddedLines`
 * is the accumulated {@link addedLines} output of a campaign chain's EARLIER
 * links; omit it (or pass `[]`) for single-shot cells and churnRatio reports
 * null — "not measurable", never a fake clean 0.
 */
export function computeSlopMetrics(inputs: {
  diff: string;
  earlierAddedLines?: string[];
}): SlopMetrics {
  const added = addedLines(inputs.diff);
  const removed = removedLines(inputs.diff);
  // Production-code-hygiene metrics grade shipped production code only: doc and
  // test files are excluded so thoroughness the Craft judge rewards is not
  // double-penalized here (issue #43). testTamper stays on the FULL diff — it
  // operates on test files by design.
  const productionAdded = productionAddedLines(inputs.diff);
  const dup = duplicationDelta(inputs.diff);
  return {
    duplicationDelta: dup.count,
    duplicationEvidence: dup.evidence,
    productionAddedLineCount: productionAdded.length,
    churnRatio: computeChurnRatio(removed, inputs.earlierAddedLines),
    residue: countResidue(productionAdded),
    testTamper: detectTestTamper(added, removed),
    helperReuse: helperReuseCount(productionAdded),
    literalDensity: literalDensityCount(productionAdded),
  };
}
