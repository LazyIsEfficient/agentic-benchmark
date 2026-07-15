import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addedLines,
  computeSlopMetrics,
  isGeneratedFile,
  isTestFile,
  removedLines,
} from "./slop.js";

// --- Fixture diffs (unified git diff strings) --------------------------------

const EMPTY_DIFF = "";

/** A 4-line block that is duplication-eligible (≥3 non-empty, ≥40 sig chars). */
const BLOCK = `+const total = items.reduce((sum, item) => sum + item.price, 0);
+if (total > limit) {
+  throw new Error("over limit");
+}`;

/** The eligible block appears twice in ONE file, separated by a unique line. */
const DUP_TWICE_ONE_FILE = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,11 @@
${BLOCK}
+function separatorBetweenCopies() {}
${BLOCK}
`;

/** The eligible block appears once in EACH of two different files. */
const DUP_ACROSS_FILES = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,1 +1,5 @@
${BLOCK}
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,1 +1,5 @@
${BLOCK}
`;

/** The eligible block appears once in each of THREE files (N=3 → delta 2). */
const DUP_THRICE = `${DUP_ACROSS_FILES}diff --git a/src/c.ts b/src/c.ts
--- a/src/c.ts
+++ b/src/c.ts
@@ -1,1 +1,5 @@
${BLOCK}
`;

/**
 * The block's first 3 lines end file a, its last line starts file b, and file
 * c holds the whole block. If windows crossed file boundaries, a+b would form
 * a window identical to c's and delta would be 1; it must be 0.
 */
const STRADDLE_FILES = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,1 +1,4 @@
+const total = items.reduce((sum, item) => sum + item.price, 0);
+if (total > limit) {
+  throw new Error("over limit");
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,1 +1,2 @@
+}
diff --git a/src/c.ts b/src/c.ts
--- a/src/c.ts
+++ b/src/c.ts
@@ -1,1 +1,5 @@
${BLOCK}
`;

/** Same block, re-indented with extra internal spaces — normalization must match it. */
const DUP_WHITESPACE_VARIANT = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,1 +1,5 @@
${BLOCK}
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,1 +1,5 @@
+    const   total = items.reduce((sum, item)  =>  sum + item.price, 0);
+  if  (total > limit) {
+      throw new Error("over limit");
+  }
`;

/** A duplicated 4-line window with only 2 non-empty lines — below the floor. */
const DUP_MOSTLY_BLANK = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,1 +1,4 @@
+const firstMeaningfulLineIsQuiteLongIndeed = computeEverything();
+
+
+const secondMeaningfulLineAlsoQuiteLongYes = computeMore();
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,1 +1,4 @@
+const firstMeaningfulLineIsQuiteLongIndeed = computeEverything();
+
+
+const secondMeaningfulLineAlsoQuiteLongYes = computeMore();
`;

/** A duplicated 4-line window of brace noise — under 40 significant chars. */
const DUP_BRACE_NOISE = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,1 +1,4 @@
+}
+)
+];
+{
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,1 +1,4 @@
+}
+)
+];
+{
`;

/** Only removed lines (a pure deletion), no assertions among them. */
const ONLY_REMOVED_DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +0,0 @@
-const a = helperOne();
-const b = helperTwo();
-// TODO in a removed line must not count as residue
`;

/** Residue of every flavor in the added lines, plus removed/context decoys. */
const RESIDUE_DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,9 @@
+// TODO: wire this up properly
+const x = compute(); // FIXME later
+console.log("debug", x);
+  debugger;
+// const old = compute();
+// items.map((i) => i.price)
+// This explains the approach in plain prose
+// TODO of a comment explaining return values later
-// TODO removed lines must not count
 // TODO context lines must not count
`;

/** One added line per tamper signal, plus three deleted assertions. */
const TAMPER_DIFF = `diff --git a/src/a.test.ts b/src/a.test.ts
--- a/src/a.test.ts
+++ b/src/a.test.ts
@@ -1,6 +1,8 @@
+it.skip("flaky test", () => {});
+describe.only("just this", () => {});
+xit("disabled", () => {});
+xdescribe("disabled suite", () => {});
+test.todo("write later");
+/* eslint-disable no-unused-vars */
+// @ts-nocheck
+const cmd = "jest --passWithNoTests";
-  expect(total).toBe(42);
-  assert.equal(a, b);
-  assert(ok);
`;

// --- addedLines / removedLines ------------------------------------------------

test("addedLines returns raw + lines (whitespace and blanks kept), never +++ headers", () => {
  const diff = `diff --git a/src/TODO.ts b/src/TODO.ts
--- a/src/TODO.ts
+++ b/src/TODO.ts
@@ -1,1 +1,3 @@
+  indented line kept raw
+
+const x = 1;
 context line
-removed line
`;
  assert.deepEqual(addedLines(diff), ["  indented line kept raw", "", "const x = 1;"]);
});

test("removedLines returns raw - lines, never --- headers", () => {
  const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,1 @@
-  gone();
-
+kept();
`;
  assert.deepEqual(removedLines(diff), ["  gone();", ""]);
});

test("addedLines/removedLines on an empty diff are empty", () => {
  assert.deepEqual(addedLines(EMPTY_DIFF), []);
  assert.deepEqual(removedLines(EMPTY_DIFF), []);
});

test("a +++ header with a TODO-ish path is not residue (headers are not added lines)", () => {
  const diff = `diff --git a/src/TODO.ts b/src/TODO.ts
--- a/src/TODO.ts
+++ b/src/TODO.ts
@@ -1,1 +1,1 @@
 unchanged context line
`;
  const m = computeSlopMetrics({ diff });
  assert.equal(m.residue.todos, 0);
});

// --- duplicationDelta -----------------------------------------------------------

test("an ordinary diff with no repeated windows has duplicationDelta 0", () => {
  const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,1 +1,5 @@
${BLOCK}
`;
  assert.equal(computeSlopMetrics({ diff }).duplicationDelta, 0);
});

test("the same eligible block twice in one file counts 1 (N-1)", () => {
  assert.equal(computeSlopMetrics({ diff: DUP_TWICE_ONE_FILE }).duplicationDelta, 1);
});

test("identical windows in two DIFFERENT files count as duplication", () => {
  assert.equal(computeSlopMetrics({ diff: DUP_ACROSS_FILES }).duplicationDelta, 1);
});

test("three identical windows count 2 (each extra occurrence is 1)", () => {
  assert.equal(computeSlopMetrics({ diff: DUP_THRICE }).duplicationDelta, 2);
});

test("normalization: re-indented / respaced copies still count as duplicates", () => {
  assert.equal(computeSlopMetrics({ diff: DUP_WHITESPACE_VARIANT }).duplicationDelta, 1);
});

test("windows never straddle a file boundary", () => {
  assert.equal(computeSlopMetrics({ diff: STRADDLE_FILES }).duplicationDelta, 0);
});

test("windows with fewer than 3 non-empty lines are skipped even when duplicated", () => {
  assert.equal(computeSlopMetrics({ diff: DUP_MOSTLY_BLANK }).duplicationDelta, 0);
});

test("windows under 40 significant chars (brace noise) are skipped even when duplicated", () => {
  assert.equal(computeSlopMetrics({ diff: DUP_BRACE_NOISE }).duplicationDelta, 0);
});

test("duplication carries capped per-file evidence for the windows that repeated", () => {
  const m = computeSlopMetrics({ diff: DUP_TWICE_ONE_FILE });
  assert.equal(m.duplicationDelta, 1);
  assert.equal(m.duplicationEvidence?.length, 1);
  assert.equal(m.duplicationEvidence?.[0]?.file, "src/a.ts");
  assert.match(m.duplicationEvidence?.[0]?.excerpt ?? "", /const total = items\.reduce/);
});

test("a clean production diff records no duplication evidence", () => {
  const m = computeSlopMetrics({ diff: DUP_ACROSS_FILES.replace(/src\/b\.ts/g, "docs/b.md") });
  // (a.ts still holds the block once; nothing repeats in production) → no evidence
  assert.equal(m.duplicationDelta, 0);
  assert.deepEqual(m.duplicationEvidence, []);
});

// --- doc/test exclusion from production-code hygiene (#43) -------------------------

/** The duplicated block twice in a TEST file — must NOT inflate duplication. */
const DUP_IN_TEST_FILE = `diff --git a/src/a.test.ts b/src/a.test.ts
--- a/src/a.test.ts
+++ b/src/a.test.ts
@@ -1,2 +1,11 @@
${BLOCK}
+function separatorBetweenCopies() {}
${BLOCK}
`;

/** The duplicated block twice in a DOC file — must NOT inflate duplication. */
const DUP_IN_DOC_FILE = `diff --git a/docs/guide.md b/docs/guide.md
--- a/docs/guide.md
+++ b/docs/guide.md
@@ -1,2 +1,11 @@
${BLOCK}
+function separatorBetweenCopies() {}
${BLOCK}
`;

/** Residue markers shipped inside a TEST file — must NOT count as production residue. */
const RESIDUE_IN_TEST_FILE = `diff --git a/test/webhooks.test.mjs b/test/webhooks.test.mjs
--- a/test/webhooks.test.mjs
+++ b/test/webhooks.test.mjs
@@ -1,1 +1,4 @@
+// TODO: wire this up properly
+console.log("debug", x);
+  debugger;
`;

test("a repetitive TEST file does not inflate duplication (and records no evidence)", () => {
  const m = computeSlopMetrics({ diff: DUP_IN_TEST_FILE });
  assert.equal(m.duplicationDelta, 0);
  assert.deepEqual(m.duplicationEvidence, []);
});

test("a repetitive DOC file does not inflate duplication (and records no evidence)", () => {
  const m = computeSlopMetrics({ diff: DUP_IN_DOC_FILE });
  assert.equal(m.duplicationDelta, 0);
  assert.deepEqual(m.duplicationEvidence, []);
});

test("a repetitive PRODUCTION file STILL inflates duplication", () => {
  // Same block, same shape — only the path differs from the test/doc fixtures.
  assert.equal(computeSlopMetrics({ diff: DUP_TWICE_ONE_FILE }).duplicationDelta, 1);
});

test("residue in a TEST file is not counted as production residue", () => {
  const m = computeSlopMetrics({ diff: RESIDUE_IN_TEST_FILE });
  assert.deepEqual(m.residue, { todos: 0, debugLogging: 0, commentedOutCode: 0 });
});

test("testTamper STILL counts weakening inside a test file (the deliberate exception)", () => {
  // TAMPER_DIFF lives in src/a.test.ts; the exclusion must NOT silence it.
  const m = computeSlopMetrics({ diff: TAMPER_DIFF });
  assert.equal(m.testTamper.hits, 11);
});

test("isTestFile matches infix and directory-segment forms, case-insensitively", () => {
  assert.equal(isTestFile("src/foo.test.ts"), true);
  assert.equal(isTestFile("test/webhooks.test.mjs"), true);
  assert.equal(isTestFile("src/bar.spec.ts"), true); // .spec. infix IS a test file
  assert.equal(isTestFile("__tests__/helpers.mjs"), true);
  assert.equal(isTestFile("packages/x/tests/run.ts"), true);
  assert.equal(isTestFile("Src/Foo.Test.TS"), true); // case-insensitive
  assert.equal(isTestFile("src/latest.ts"), false); // "test" only as a substring, not a segment/infix
  assert.equal(isTestFile("src/contest.ts"), false);
  // A bare `spec/` directory is a PRODUCTION API/schema spec, NOT a test file —
  // its slop must stay measured (reviewer should-fix on #43).
  assert.equal(isTestFile("spec/openapi.yaml"), false);
  assert.equal(isTestFile("api/spec/user.schema.ts"), false);
});

// --- generated lockfile exclusion from production-code hygiene (#45) ---------------

/** The duplicated block twice in a GENERATED lockfile — must NOT inflate duplication. */
const DUP_IN_LOCKFILE = `diff --git a/package-lock.json b/package-lock.json
--- a/package-lock.json
+++ b/package-lock.json
@@ -1,2 +1,11 @@
${BLOCK}
+"separatorBetweenCopies": {},
${BLOCK}
`;

/** The same block twice in a lockfile nested under a subdirectory path. */
const DUP_IN_NESTED_LOCKFILE = `diff --git a/packages/api/package-lock.json b/packages/api/package-lock.json
--- a/packages/api/package-lock.json
+++ b/packages/api/package-lock.json
@@ -1,2 +1,11 @@
${BLOCK}
+"separatorBetweenCopies": {},
${BLOCK}
`;

/** The same block twice in an UPPERCASE lockfile name — matching is case-insensitive. */
const DUP_IN_UPPERCASE_LOCKFILE = `diff --git a/PACKAGE-LOCK.JSON b/PACKAGE-LOCK.JSON
--- a/PACKAGE-LOCK.JSON
+++ b/PACKAGE-LOCK.JSON
@@ -1,2 +1,11 @@
${BLOCK}
+"separatorBetweenCopies": {},
${BLOCK}
`;

/** The same block twice in package.json — AUTHORED, so it MUST stay counted. */
const DUP_IN_PACKAGE_JSON = `diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -1,2 +1,11 @@
${BLOCK}
+"separatorBetweenCopies": {},
${BLOCK}
`;

test("a repetitive lockfile does not inflate duplication (and records no evidence)", () => {
  const m = computeSlopMetrics({ diff: DUP_IN_LOCKFILE });
  assert.equal(m.duplicationDelta, 0);
  assert.deepEqual(m.duplicationEvidence, []);
});

test("a lockfile nested under a subdirectory path is also excluded", () => {
  const m = computeSlopMetrics({ diff: DUP_IN_NESTED_LOCKFILE });
  assert.equal(m.duplicationDelta, 0);
  assert.deepEqual(m.duplicationEvidence, []);
});

test("lockfile matching is case-insensitive (PACKAGE-LOCK.JSON)", () => {
  const m = computeSlopMetrics({ diff: DUP_IN_UPPERCASE_LOCKFILE });
  assert.equal(m.duplicationDelta, 0);
  assert.deepEqual(m.duplicationEvidence, []);
});

test("a lockfile-only diff has zero production lines → SlopHealth guard (#43) still holds", () => {
  // No production lines were added; downstream this yields a null SlopHealth,
  // never a fake-clean 100.
  const m = computeSlopMetrics({ diff: DUP_IN_LOCKFILE });
  assert.equal(m.productionAddedLineCount, 0);
  assert.deepEqual(m.residue, { todos: 0, debugLogging: 0, commentedOutCode: 0 });
});

test("a repetitive package.json STILL inflates duplication (authored, not generated)", () => {
  const m = computeSlopMetrics({ diff: DUP_IN_PACKAGE_JSON });
  assert.equal(m.duplicationDelta, 1);
  assert.equal(m.productionAddedLineCount, 9); // two 4-line blocks + the separator, all counted
});

test("a repetitive PRODUCTION .ts file STILL inflates duplication alongside the lockfile carve-out", () => {
  assert.equal(computeSlopMetrics({ diff: DUP_TWICE_ONE_FILE }).duplicationDelta, 1);
});

test("isGeneratedFile matches lockfiles by basename, case-insensitively; authored config stays counted", () => {
  assert.equal(isGeneratedFile("package-lock.json"), true);
  assert.equal(isGeneratedFile("packages/api/package-lock.json"), true);
  assert.equal(isGeneratedFile("PACKAGE-LOCK.JSON"), true);
  assert.equal(isGeneratedFile("npm-shrinkwrap.json"), true);
  assert.equal(isGeneratedFile("yarn.lock"), true);
  assert.equal(isGeneratedFile("pnpm-lock.yaml"), true);
  assert.equal(isGeneratedFile("bun.lockb"), true);
  // Authored files are NOT generated — they stay measured.
  assert.equal(isGeneratedFile("package.json"), false);
  assert.equal(isGeneratedFile("tsconfig.json"), false);
  assert.equal(isGeneratedFile("src/package-lock.json.ts"), false); // not the basename
});

// --- churnRatio -------------------------------------------------------------------

const CHURN_DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,1 @@
-const dropMe = legacyHelper();
-const dropMeToo = legacyHelperTwo();
-const neverAddedEarlier = stranger();
+const replacement = modernHelper();
`;

test("churnRatio is null when earlierAddedLines is undefined or empty", () => {
  assert.equal(computeSlopMetrics({ diff: CHURN_DIFF }).churnRatio, null);
  assert.equal(
    computeSlopMetrics({ diff: CHURN_DIFF, earlierAddedLines: [] }).churnRatio,
    null,
  );
});

test("churnRatio = matched removed lines / earlierAddedLines.length", () => {
  const earlier = [
    "const dropMe = legacyHelper();",
    "const dropMeToo = legacyHelperTwo();",
    "const kept = stillHere();",
    "const alsoKept = stillHereToo();",
  ];
  const m = computeSlopMetrics({ diff: CHURN_DIFF, earlierAddedLines: earlier });
  assert.equal(m.churnRatio, 2 / 4);
});

test("churnRatio is 0 when no removed line matches earlier work", () => {
  const earlier = ["const unrelated = 1;"];
  const m = computeSlopMetrics({ diff: CHURN_DIFF, earlierAddedLines: earlier });
  assert.equal(m.churnRatio, 0);
});

test("churn matching is multiset: earlier has X once, diff removes X twice → numerator 1", () => {
  const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,1 @@
-const x = 1;
-other line;
-const x = 1;
+const x = 2;
`;
  const m = computeSlopMetrics({ diff, earlierAddedLines: ["const x = 1;"] });
  assert.equal(m.churnRatio, 1); // 1 matched / 1 earlier line — never 2/1
});

test("churn matching trims both sides", () => {
  const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,1 +1,1 @@
-const y = 2;
+const y = 3;
`;
  const m = computeSlopMetrics({ diff, earlierAddedLines: ["    const y = 2;"] });
  assert.equal(m.churnRatio, 1);
});

test("blank lines never match in churn (but stay in the denominator)", () => {
  const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,0 @@
-
-const a = 1;
`;
  const m = computeSlopMetrics({ diff, earlierAddedLines: ["", "const a = 1;"] });
  assert.equal(m.churnRatio, 1 / 2); // only the real line matches, not the blank
});

// --- residue -------------------------------------------------------------------------

test("residue counts TODO/debug/commented-code over added lines only", () => {
  const m = computeSlopMetrics({ diff: RESIDUE_DIFF });
  // TODO:, FIXME (in a trailing comment), and the TODO-prose line; removed and
  // context TODO decoys are excluded.
  assert.equal(m.residue.todos, 3);
  // console.log(...) and the bare debugger statement.
  assert.equal(m.residue.debugLogging, 2);
  // `// const old = compute();` and `// items.map((i) => i.price)`; the two
  // prose comments must not count.
  assert.equal(m.residue.commentedOutCode, 2);
});

test("the required TODO-prose edge: counts for todos but NOT commentedOutCode", () => {
  const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,1 +1,2 @@
+// TODO of a comment explaining return values later
`;
  const m = computeSlopMetrics({ diff });
  assert.equal(m.residue.todos, 1);
  assert.equal(m.residue.commentedOutCode, 0);
});

test("todo markers respect word boundaries (XXXL is not XXX) and match HACK/XXX", () => {
  const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,1 +1,4 @@
+const shirtSize = "XXXL";
+// XXX revisit this
+// HACK around the flaky API
+const todoList = loadTodos();
`;
  const m = computeSlopMetrics({ diff });
  assert.equal(m.residue.todos, 2); // XXX + HACK; XXXL and lowercase todoList don't match
});

test("debugLogging matches console.log/debug/trace and debugger, not console.error/info", () => {
  const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,1 +1,7 @@
+console.log("a");
+console.debug ("b");
+console.trace("c");
+debugger;
+console.error("kept: real error handling");
+console.info("kept");
+const dodebugger = 1;
`;
  const m = computeSlopMetrics({ diff });
  assert.equal(m.residue.debugLogging, 4);
});

test("commentedOutCode: JSDoc-star and block-comment code lines count, keyword prose does not", () => {
  const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,1 +1,6 @@
+ * return fetchUser(id);
+/* let cache = new Map(); */
+// await the response later
+// import duties are a customs concept
+const inline = 1; // not a comment line at all;
`;
  const m = computeSlopMetrics({ diff });
  // `* return fetchUser(id);` and `/* let cache = new Map(); */` look like
  // code; the two keyword-bearing prose lines lack code punctuation after the
  // keyword and must not count; the last line is code, not a comment.
  assert.equal(m.residue.commentedOutCode, 2);
});

// --- testTamper ------------------------------------------------------------------------

test("every tamper signal is detected with '<signal>: <excerpt>' evidence", () => {
  const m = computeSlopMetrics({ diff: TAMPER_DIFF });
  // 8 added-signal lines + 3 deleted assertions.
  assert.equal(m.testTamper.hits, 11);
  // Evidence is capped at 10 even though there are 11 hits.
  assert.equal(m.testTamper.evidence.length, 10);
  assert.equal(m.testTamper.evidence[0], '.skip(: it.skip("flaky test", () => {});');
  assert.equal(m.testTamper.evidence[8], "deleted-assertion: expect(total).toBe(42);");
  const signals = m.testTamper.evidence.map((e) => e.split(":")[0]);
  for (const expected of [
    ".skip(",
    ".only(",
    "xit(",
    "xdescribe(",
    "test.todo(",
    "eslint-disable",
    "@ts-nocheck",
    "--passWithNoTests",
    "deleted-assertion",
  ]) {
    assert.ok(signals.includes(expected), `missing signal ${expected}`);
  }
});

test("one added line matching two signals counts once per signal", () => {
  const diff = `diff --git a/src/a.test.ts b/src/a.test.ts
--- a/src/a.test.ts
+++ b/src/a.test.ts
@@ -1,1 +1,2 @@
+afterEach(() => suite.only(tests.skip(1)));
`;
  const m = computeSlopMetrics({ diff });
  assert.equal(m.testTamper.hits, 2);
  assert.equal(m.testTamper.evidence.length, 2);
});

test("process.exit( and identifiers ending in xit are NOT tamper; bare xit( is", () => {
  const diff = `diff --git a/src/cli.ts b/src/cli.ts
--- a/src/cli.ts
+++ b/src/cli.ts
@@ -1,1 +1,4 @@
+process.exit(1);
+const onExit = doExit(code);
+xit("disabled test", () => {});
`;
  const m = computeSlopMetrics({ diff });
  assert.equal(m.testTamper.hits, 1);
  assert.equal(m.testTamper.evidence[0], 'xit(: xit("disabled test", () => {});');
});

test("a removed line with several assertion tokens is ONE deleted-assertion hit", () => {
  const diff = `diff --git a/src/a.test.ts b/src/a.test.ts
--- a/src/a.test.ts
+++ b/src/a.test.ts
@@ -1,1 +1,0 @@
-expect(assert.deepEqual(x)).toBe(assert(y));
`;
  const m = computeSlopMetrics({ diff });
  assert.equal(m.testTamper.hits, 1);
  assert.equal(m.testTamper.evidence[0]?.startsWith("deleted-assertion:"), true);
});

test("ADDED assertions are not tamper; only removed ones are", () => {
  const diff = `diff --git a/src/a.test.ts b/src/a.test.ts
--- a/src/a.test.ts
+++ b/src/a.test.ts
@@ -1,1 +1,2 @@
+expect(total).toBe(42);
+assert.equal(a, b);
`;
  const m = computeSlopMetrics({ diff });
  assert.equal(m.testTamper.hits, 0);
  assert.deepEqual(m.testTamper.evidence, []);
});

test("rewriting an assertion for a changed data shape nets to 0 tamper hits", () => {
  // t3-created-at pattern: adding a `createdAt` field forces the expected value
  // to change, so the old deepEqual is deleted and an updated one re-added.
  const diff = `diff --git a/src/store.test.ts b/src/store.test.ts
--- a/src/store.test.ts
+++ b/src/store.test.ts
@@ -1,6 +1,6 @@
-  assert.deepEqual(store.all(), [{ title: "Todo", body: "clean the house" }]);
-  assert.deepEqual(store.get("Shopping List"), {
+  assert.deepEqual(store.all(), [{ title: "Todo", body: "clean the house", createdAt: ts }]);
+  assert.deepEqual(store.get("Shopping List"), {
     title: "Shopping List",
+    createdAt: ts,
   });
`;
  const m = computeSlopMetrics({ diff });
  assert.equal(m.testTamper.hits, 0);
  assert.deepEqual(m.testTamper.evidence, []);
});

test("a deleted assertion with no re-added counterpart still counts as tamper", () => {
  // Two subjects removed; only ONE is re-asserted → the other is a net deletion.
  const diff = `diff --git a/src/store.test.ts b/src/store.test.ts
--- a/src/store.test.ts
+++ b/src/store.test.ts
@@ -1,4 +1,2 @@
-  assert.deepEqual(store.all(), [{ title: "Todo" }]);
-  assert.equal(store.size(), 1);
+  assert.deepEqual(store.all(), [{ title: "Todo", createdAt: ts }]);
`;
  const m = computeSlopMetrics({ diff });
  assert.equal(m.testTamper.hits, 1);
  assert.equal(m.testTamper.evidence.length, 1);
  assert.equal(
    m.testTamper.evidence[0],
    "deleted-assertion: assert.equal(store.size(), 1);",
  );
});

test("KNOWN BLIND SPOT: same-subject value-weakening rewrite nets to 0 (intentional)", () => {
  // Deleting a strong expected value and re-adding a weakened one for the SAME
  // subject nets to zero, because the shape deliberately excludes the expected
  // value. This is an accepted tradeoff (see assertionShape docstring): the
  // alternative re-introduces false positives on every legitimate expected-value
  // update. Pinned so a future reader knows this is intentional, not an accident.
  const diff = `diff --git a/src/store.test.ts b/src/store.test.ts
--- a/src/store.test.ts
+++ b/src/store.test.ts
@@ -1,2 +1,2 @@
-  assert.deepEqual(store.all(), [{ title: "Todo", body: "clean the house" }]);
+  assert.deepEqual(store.all(), []);
`;
  const m = computeSlopMetrics({ diff });
  assert.equal(m.testTamper.hits, 0);
  assert.deepEqual(m.testTamper.evidence, []);
});

test("evidence excerpts are trimmed and capped at 80 chars", () => {
  const longTail = "x".repeat(120);
  const diff = `diff --git a/src/a.test.ts b/src/a.test.ts
--- a/src/a.test.ts
+++ b/src/a.test.ts
@@ -1,1 +1,2 @@
+    it.skip("${longTail}");
`;
  const m = computeSlopMetrics({ diff });
  const entry = m.testTamper.evidence[0]!;
  assert.ok(entry.startsWith('.skip(: it.skip("x'));
  assert.equal(entry.length, ".skip(: ".length + 80);
});

// --- computeSlopMetrics: required end-to-end edges --------------------------------------

test("empty diff → everything zero, churnRatio null, no tamper evidence", () => {
  const m = computeSlopMetrics({ diff: EMPTY_DIFF });
  assert.deepEqual(m, {
    duplicationDelta: 0,
    duplicationEvidence: [],
    productionAddedLineCount: 0,
    churnRatio: null,
    residue: { todos: 0, debugLogging: 0, commentedOutCode: 0 },
    testTamper: { hits: 0, evidence: [] },
    helperReuse: 0,
    literalDensity: 0,
  });
});

test("a diff with only removed lines: no duplication, no residue, churn measurable", () => {
  const withoutEarlier = computeSlopMetrics({ diff: ONLY_REMOVED_DIFF });
  assert.equal(withoutEarlier.duplicationDelta, 0);
  assert.equal(withoutEarlier.churnRatio, null);
  assert.deepEqual(withoutEarlier.residue, {
    todos: 0,
    debugLogging: 0,
    commentedOutCode: 0,
  });
  assert.equal(withoutEarlier.testTamper.hits, 0);

  const withEarlier = computeSlopMetrics({
    diff: ONLY_REMOVED_DIFF,
    earlierAddedLines: ["const a = helperOne();", "const b = helperTwo();"],
  });
  assert.equal(withEarlier.churnRatio, 1); // deleted 100% of its earlier work
});

test("a deletion-only diff that removes assertions still flags tamper", () => {
  const diff = `diff --git a/src/a.test.ts b/src/a.test.ts
--- a/src/a.test.ts
+++ b/src/a.test.ts
@@ -1,2 +0,0 @@
-  expect(sum(1, 2)).toBe(3);
-  assert.ok(isValid);
`;
  const m = computeSlopMetrics({ diff });
  assert.equal(m.testTamper.hits, 2);
  assert.equal(m.testTamper.evidence.length, 2);
});

// --- helperReuse (#16) -----------------------------------------------------------------

test("helperReuse: an extracted helper called from N sites scores N; the declaration itself is not a call", () => {
  const diff = `diff --git a/src/id.ts b/src/id.ts
--- a/src/id.ts
+++ b/src/id.ts
@@ -1,1 +1,6 @@
+function generateId(prefix) {
+  return prefix + Date.now();
+}
+const a = generateId("u");
+const b = generateId("o");
+const c = generateId("p");
`;
  // 3 call-sites; the function generateId( declaration line is not counted.
  assert.equal(computeSlopMetrics({ diff }).helperReuse, 3);
});

test("helperReuse: arrow helpers count their reuses, and only diff-declared names count", () => {
  const diff = `diff --git a/src/u.ts b/src/u.ts
--- a/src/u.ts
+++ b/src/u.ts
@@ -1,1 +1,4 @@
+const slug = (s) => s.toLowerCase();
+const x = slug(name);
+const y = slug(title);
+const z = external(value);
`;
  // slug: declared as arrow (self-declaration is "slug =", not a call) → 2 reuses.
  // external() is not declared in the diff → never counted.
  assert.equal(computeSlopMetrics({ diff }).helperReuse, 2);
});

test("helperReuse: inlined duplication with no shared helper scores 0 (the generateId drift)", () => {
  const diff = `diff --git a/src/inline.ts b/src/inline.ts
--- a/src/inline.ts
+++ b/src/inline.ts
@@ -1,1 +1,3 @@
+const a = "user_" + Date.now() + Math.random();
+const b = "order_" + Date.now() + Math.random();
+const c = "post_" + Date.now() + Math.random();
`;
  assert.equal(computeSlopMetrics({ diff }).helperReuse, 0);
});

// --- literalDensity (#16) --------------------------------------------------------------

test("literalDensity: counts inlined magic numbers and strings, skips single-digit ints and 1-char strings", () => {
  const diff = `diff --git a/src/cfg.ts b/src/cfg.ts
--- a/src/cfg.ts
+++ b/src/cfg.ts
@@ -1,1 +1,3 @@
+if (retries > 3) throw new Error("too many retries");
+const delay = elapsed * 1000 + 250;
+setTimeout(fn, i);
`;
  // "too many retries" (string) + 1000 + 250 = 3 magic literals; 3 and i are skipped.
  assert.equal(computeSlopMetrics({ diff }).literalDensity, 3);
});

test("literalDensity: a named-constant declaration is the healthy pattern — its RHS literals do NOT count", () => {
  const diff = `diff --git a/src/cfg.ts b/src/cfg.ts
--- a/src/cfg.ts
+++ b/src/cfg.ts
@@ -1,1 +1,2 @@
+const MAX_RETRIES = 3600;
+const LABEL = "checkout-service";
`;
  assert.equal(computeSlopMetrics({ diff }).literalDensity, 0);
});

test("literalDensity: comment and import lines never count as inlined literals", () => {
  const diff = `diff --git a/src/cfg.ts b/src/cfg.ts
--- a/src/cfg.ts
+++ b/src/cfg.ts
@@ -1,1 +1,3 @@
+import { thing } from "some-long-module-path";
+// magic 4096 in a comment "quoted" stays out
+thing(4096);
`;
  // Only the inlined 4096 in real code counts; the import specifier and comment do not.
  assert.equal(computeSlopMetrics({ diff }).literalDensity, 1);
});
