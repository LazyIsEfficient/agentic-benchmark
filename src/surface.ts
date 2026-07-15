/**
 * Expected-surface scoping — the deterministic half of the blast-radius axis.
 *
 * A task ({@link TaskMeta.expectedSurface}) or campaign link
 * ({@link CampaignTask.expectedSurface}) may declare glob patterns of the files
 * the agent is EXPECTED to touch. This module mechanically computes which
 * touched files fall OUTSIDE that surface; an LLM judge later classifies each
 * excursion (necessary / defensible / overreach / adversarial). Scope is
 * decided HERE, so the judge only grades excursions — it never gets to argue
 * about what counts as out-of-scope.
 *
 * Pure over strings: no fs, no container, and no glob dependency — the repo is
 * deliberately dependency-light (tsx + typescript only) and the dialect needed
 * here is small enough to own outright.
 */

import type { CampaignTask, TaskMeta } from "./types.js";

// --- Normalization ------------------------------------------------------------

/**
 * Strip leading `./` prefixes. Touched paths come from git as clean
 * workspace-relative forward-slash paths, but fixture authors plausibly write
 * `./src/**` and defensive callers may hand in `./`-prefixed paths — both must
 * name the same file. Applied to patterns ({@link globToRegExp}) AND paths
 * ({@link filesOutsideExpectedSurface}) so the two sides can never disagree.
 */
function stripDotSlash(p: string): string {
  let out = p;
  while (out.startsWith("./")) out = out.slice(2);
  return out;
}

// --- Glob compilation -----------------------------------------------------------

/** Regex metacharacters that must be escaped when taken literally from a glob. */
const REGEX_SPECIALS = new Set([".", "+", "(", ")", "[", "]", "{", "}", "^", "$", "|", "\\"]);

/**
 * Translate one path SEGMENT (contains no `/`) to regex source: `*` → any run
 * of non-`/` chars, `?` → exactly one non-`/` char, everything else literal
 * (metachars escaped, so `file(1).ts` means the literal path). `*` and `?`
 * never cross a segment boundary — that power is reserved for the
 * whole-segment `**`, handled by the caller.
 */
function segmentToRegExpSource(segment: string): string {
  let out = "";
  for (const ch of segment) {
    if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else if (REGEX_SPECIALS.has(ch)) out += `\\${ch}`;
    else out += ch;
  }
  return out;
}

/**
 * Compile one expectedSurface glob to a fully anchored (`^…$`) RegExp.
 * Exported for direct testability; {@link filesOutsideExpectedSurface} is the
 * real consumer.
 *
 * Dialect (deliberately small):
 * - `**` as a whole segment matches any number of segments INCLUDING none:
 *   `a/**\/b` matches `a/b` as well as `a/x/y/b`. Compiled as `(?:[^/]+/)*` —
 *   each matched segment consumes its own trailing slash, so the zero-segment
 *   case leaves no dangling `/`.
 * - A trailing `**` (`src/**`) requires the `src/` prefix and matches children
 *   only, never bare `src`. Deliberate: touched paths are always FILES, never
 *   directories, so the only thing `src/**` matching `src` could do is let a
 *   FILE named `src` slip through the scope check.
 * - `*` matches within one segment (never `/`); `?` exactly one non-`/` char.
 * - A pattern ending in `/` is directory-prefix shorthand: `docs/` ≡ `docs/**`.
 * - No glob chars at all ⇒ exact path match.
 * - Leading `./` is stripped; matching is case-sensitive, forward-slash only.
 */
export function globToRegExp(pattern: string): RegExp {
  let glob = stripDotSlash(pattern);
  if (glob.endsWith("/")) glob += "**";
  const segments = glob.split("/");
  let source = "^";
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    const isLast = i === segments.length - 1;
    if (segment === "**") {
      // Trailing ** consumes the rest of the path (segments and separators
      // alike); an inner ** consumes whole segments WITH their own slash.
      source += isLast ? ".*" : "(?:[^/]+/)*";
    } else {
      source += segmentToRegExpSource(segment);
      if (!isLast) source += "/";
    }
  }
  return new RegExp(`${source}$`);
}

// --- Surface resolution ----------------------------------------------------------

/**
 * Resolve which expected surface governs a run: a link-level declaration
 * OVERRIDES the meta-level one wholesale — never merged — because a campaign
 * link's surface is usually NARROWER than the chain-wide one, and a union
 * would silently re-widen it. Returns `undefined` when neither side declares
 * a surface, which downstream means "scoping is off for this run".
 *
 * An explicitly declared link `[]` is honored as a real (empty) surface: it
 * says "this link may touch nothing", so every touched file is out of scope.
 * That is exactly why the return type distinguishes `undefined` (nobody opted
 * in) from `[]` (someone opted in and allowed nothing) — see
 * {@link filesOutsideExpectedSurface} for the consuming side of that contract.
 */
export function expectedSurfaceFor(
  meta: Pick<TaskMeta, "expectedSurface">,
  link?: Pick<CampaignTask, "expectedSurface">,
): string[] | undefined {
  return link?.expectedSurface ?? meta.expectedSurface;
}

/**
 * Touched files matching NONE of the expected-surface globs, in first-seen
 * order, deduplicated. Dedupe is keyed on the `./`-normalized path (so
 * `./x.ts` and `x.ts` are one file); the first-seen original spelling is what
 * gets returned, so callers can map entries back to `changedFiles` verbatim.
 *
 * `undefined` surface ⇒ `[]`: scoping is opt-in per fixture, and a fixture
 * that never declared a surface has defined nothing as out of scope. This is
 * deliberately fail-OPEN — the opposite of the judge's fail-closed verdicts.
 * Those grade an observation and must not silently pass when they cannot see;
 * an absent surface is a feature nobody enabled, and manufacturing excursions
 * from silence would punish every fixture that predates the axis.
 *
 * An EMPTY array is different, and honored: {@link expectedSurfaceFor} only
 * ever produces `[]` from an explicit declaration ("this run may touch
 * nothing"), so zero patterns means every touched file is out of scope. The
 * undefined/[] distinction carries meaning — collapse it and an explicit
 * touch-nothing surface would silently disable scoping instead of flagging
 * everything.
 */
export function filesOutsideExpectedSurface(
  touchedFiles: string[],
  expectedSurface: string[] | undefined,
): string[] {
  if (expectedSurface === undefined) return [];
  const surface = expectedSurface.map(globToRegExp);
  const seen = new Set<string>();
  const outside: string[] = [];
  for (const file of touchedFiles) {
    const path = stripDotSlash(file);
    if (seen.has(path)) continue;
    seen.add(path);
    if (!surface.some((re) => re.test(path))) outside.push(file);
  }
  return outside;
}
