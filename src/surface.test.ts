import assert from "node:assert/strict";
import { test } from "node:test";
import {
  expectedSurfaceFor,
  filesOutsideExpectedSurface,
  globToRegExp,
  isDocFile,
} from "./surface.js";

// --- globToRegExp: ** semantics ------------------------------------------------

test("trailing ** matches children at any depth", () => {
  const re = globToRegExp("src/**");
  assert.equal(re.test("src/a.ts"), true);
  assert.equal(re.test("src/x/y/z.ts"), true);
});

test("trailing ** requires the directory prefix — never the bare name", () => {
  const re = globToRegExp("src/**");
  assert.equal(re.test("src"), false); // touched paths are files; a FILE named `src` is outside
  assert.equal(re.test("src2/a.ts"), false); // prefix is `src/`, not `src*`
  assert.equal(re.test("other/src/a.ts"), false); // anchored at ^
});

test("leading ** matches zero or more directories", () => {
  const re = globToRegExp("**/*.md");
  assert.equal(re.test("a.md"), true);
  assert.equal(re.test("docs/a.md"), true);
  assert.equal(re.test("docs/x/y/a.md"), true);
  assert.equal(re.test("a.mdx"), false); // anchored at $
});

test("inner ** matches zero segments without merging its neighbors", () => {
  const re = globToRegExp("a/**/b");
  assert.equal(re.test("a/b"), true); // zero segments
  assert.equal(re.test("a/x/b"), true);
  assert.equal(re.test("a/x/y/b"), true);
  assert.equal(re.test("a/xb"), false); // zero segments must not glue `a/` to `xb`
  assert.equal(re.test("ab"), false);
});

test("bare ** matches every path", () => {
  const re = globToRegExp("**");
  assert.equal(re.test("a.ts"), true);
  assert.equal(re.test("deep/x/y/z.md"), true);
});

test("**/*.test.ts matches test files at any depth, not sources", () => {
  const re = globToRegExp("**/*.test.ts");
  assert.equal(re.test("surface.test.ts"), true);
  assert.equal(re.test("src/deep/surface.test.ts"), true);
  assert.equal(re.test("src/surface.ts"), false);
});

// --- globToRegExp: single-segment wildcards --------------------------------------

test("* stays within one segment", () => {
  const re = globToRegExp("src/*.ts");
  assert.equal(re.test("src/a.ts"), true);
  assert.equal(re.test("src/x/y.ts"), false); // * never crosses /
  assert.equal(re.test("a.ts"), false);
});

test("? matches exactly one non-/ character", () => {
  const re = globToRegExp("file?.ts");
  assert.equal(re.test("file1.ts"), true);
  assert.equal(re.test("file12.ts"), false); // exactly one
  assert.equal(re.test("file.ts"), false); // not zero
  assert.equal(re.test("file/.ts"), false); // never /
});

// --- globToRegExp: literals, escaping, normalization -----------------------------

test("a pattern without glob chars is an exact path match", () => {
  const re = globToRegExp("src/config.ts");
  assert.equal(re.test("src/config.ts"), true);
  assert.equal(re.test("src/config.tsx"), false); // anchored at $
  assert.equal(re.test("lib/src/config.ts"), false); // anchored at ^
  assert.equal(re.test("src/configxts"), false); // `.` is literal, not any-char
});

test("regex metacharacters in a pattern are escaped", () => {
  const re = globToRegExp("file(1).ts");
  assert.equal(re.test("file(1).ts"), true);
  assert.equal(re.test("file1.ts"), false); // parens are literal, not a group
});

test("a pattern ending in / is directory-prefix shorthand", () => {
  const re = globToRegExp("docs/");
  assert.equal(re.test("docs/a.md"), true);
  assert.equal(re.test("docs/x/y.md"), true);
  assert.equal(re.test("docs"), false); // same children-only rule as docs/**
  assert.equal(re.test("docsx/a.md"), false);
});

test("a leading ./ on the pattern is normalized away", () => {
  assert.equal(globToRegExp("./src/**").test("src/a.ts"), true);
  assert.equal(globToRegExp("./README.md").test("README.md"), true);
});

test("matching is case-sensitive", () => {
  assert.equal(globToRegExp("src/**").test("SRC/a.ts"), false);
  assert.equal(globToRegExp("README.md").test("readme.md"), false);
});

// --- expectedSurfaceFor -----------------------------------------------------------

test("undefined when neither meta nor link declares a surface", () => {
  assert.equal(expectedSurfaceFor({}), undefined);
  assert.equal(expectedSurfaceFor({}, {}), undefined);
});

test("the meta surface applies when the link declares none", () => {
  assert.deepEqual(expectedSurfaceFor({ expectedSurface: ["src/**"] }), ["src/**"]);
  assert.deepEqual(expectedSurfaceFor({ expectedSurface: ["src/**"] }, {}), ["src/**"]);
});

test("a link surface overrides meta wholesale — no merging", () => {
  const got = expectedSurfaceFor(
    { expectedSurface: ["src/**", "docs/**"] },
    { expectedSurface: ["src/one.ts"] },
  );
  assert.deepEqual(got, ["src/one.ts"]);
});

test("an explicit empty link surface overrides a populated meta surface", () => {
  // [] is a real declaration ("this link may touch nothing"), not an absence —
  // it must NOT fall through to meta, and downstream it flags every file.
  const got = expectedSurfaceFor({ expectedSurface: ["src/**"] }, { expectedSurface: [] });
  assert.deepEqual(got, []);
});

// --- filesOutsideExpectedSurface --------------------------------------------------

test("an undefined surface disables scoping — nothing is out of scope", () => {
  assert.deepEqual(filesOutsideExpectedSurface(["a.ts", "b.ts"], undefined), []);
});

test("no touched files means no excursions, whatever the surface", () => {
  assert.deepEqual(filesOutsideExpectedSurface([], undefined), []);
  assert.deepEqual(filesOutsideExpectedSurface([], []), []);
  assert.deepEqual(filesOutsideExpectedSurface([], ["src/**"]), []);
});

test("an explicit empty surface puts every touched CODE file out of scope (docs exempt)", () => {
  // The undefined/[] distinction carries meaning: expectedSurfaceFor only ever
  // produces [] from an explicit declaration, and "may touch nothing" must
  // flag everything — not silently disable scoping. Documentation files are the
  // one exception (issue #38): a proactive doc is not scope risk, so `docs/b.md`
  // is NOT flagged even under an explicit touch-nothing surface.
  assert.deepEqual(filesOutsideExpectedSurface(["a.ts", "docs/b.md"], []), ["a.ts"]);
});

test("files matching any pattern are in scope; the rest are returned (docs never returned)", () => {
  const got = filesOutsideExpectedSurface(
    ["src/a.ts", "docs/guide.md", "scripts/build.sh", "README.md"],
    ["src/**", "*.md"],
  );
  // docs/guide.md and README.md are documentation → never an excursion (issue
  // #38); src/a.ts is in scope; only the non-doc scripts/build.sh is returned.
  assert.deepEqual(got, ["scripts/build.sh"]);
});

// --- isDocFile + blast-radius doc exemption (issue #38) ------------------------

test("isDocFile recognizes doc EXTENSIONS only — location under docs/ never qualifies code", () => {
  // Doc file extensions (case-insensitive), any location incl. under docs/.
  for (const p of ["README.md", "a.MD", "notes.mdx", "guide.markdown", "x.rst", "y.adoc"]) {
    assert.equal(isDocFile(p), true, `${p} should be a doc file`);
  }
  assert.equal(isDocFile("docs/guide.md"), true);
  assert.equal(isDocFile("Docs/guide.MD"), true); // case-insensitive path + ext
  assert.equal(isDocFile("./docs/b.md"), true); // leading ./ normalized
  // NOT documentation: a code/config file is still code/config even under docs/.
  // It MUST remain visible to blast-radius (could be overreach/adversarial).
  for (const p of [
    "docs/evil.ts",
    "docs/adr/0001.ts",
    "packages/api/docs/schema.json",
    "docs/build.sh",
    "src/a.ts",
    "config.json",
    "README.ts",
    "mdx/loader.ts",
  ]) {
    assert.equal(isDocFile(p), false, `${p} should NOT be a doc file`);
  }
});

test("filesOutsideExpectedSurface skips proactive docs but still flags code hidden under docs/", () => {
  // A DATA_MODEL.md / docs/*.md volunteered outside the surface is not scope
  // risk (issue #38) → skipped. But an unrequested CODE file still reaches
  // blast-radius — including a build script hidden in docs/ (docs/evil.ts).
  const got = filesOutsideExpectedSurface(
    ["src/handler.ts", "DATA_MODEL.md", "docs/adr/0002.md", "docs/evil.ts", "src/sneaky.ts"],
    ["src/handler.ts"],
  );
  assert.deepEqual(got, ["docs/evil.ts", "src/sneaky.ts"]);
});

test("first-seen order is preserved", () => {
  const got = filesOutsideExpectedSurface(["z.ts", "a.ts", "m.ts"], ["nothing/**"]);
  assert.deepEqual(got, ["z.ts", "a.ts", "m.ts"]);
});

test("duplicate touched paths collapse to the first occurrence", () => {
  const got = filesOutsideExpectedSurface(["a.ts", "b.ts", "a.ts"], ["nothing/**"]);
  assert.deepEqual(got, ["a.ts", "b.ts"]);
});

test("./ prefixes on touched paths are normalized for matching and dedupe", () => {
  // ./src/a.ts is IN scope under src/** …
  assert.deepEqual(filesOutsideExpectedSurface(["./src/a.ts"], ["src/**"]), []);
  // … and ./x.ts / x.ts are one file: the first-seen spelling is returned.
  assert.deepEqual(filesOutsideExpectedSurface(["./x.ts", "x.ts"], ["src/**"]), ["./x.ts"]);
});
