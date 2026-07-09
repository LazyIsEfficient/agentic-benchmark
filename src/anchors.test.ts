import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyMoneyConvention,
  detectAnchor,
  extractAddedLines,
  type FinalStep,
} from "./anchors.js";
import type { AnchorConfig } from "./types.js";

// --- Fixture diffs (unified git diff, added-line focused) -------------------

/** An integer-cents change: integer arithmetic on `*Cents` fields, no floats. */
const INTEGER_CENTS_DIFF = `diff --git a/src/price.ts b/src/price.ts
--- a/src/price.ts
+++ b/src/price.ts
@@ -1,3 +1,5 @@
+export function lineTotal(unitCents: number, qty: number): number {
+  return unitCents * qty;
+}
+const subtotalCents = lineTotal(199, 3);
`;

/** A parseFloat / float-literal change: money handled as floating point. */
const PARSE_FLOAT_DIFF = `diff --git a/src/price.ts b/src/price.ts
--- a/src/price.ts
+++ b/src/price.ts
@@ -1,2 +1,3 @@
+export function total(amount: string): number {
+  return parseFloat(amount) + 1.99;
+}
`;

/** A .toFixed float-formatting change (float, no explicit parseFloat). */
const TOFIXED_DIFF = `diff --git a/src/price.ts b/src/price.ts
--- a/src/price.ts
+++ b/src/price.ts
@@ -1,1 +1,2 @@
+const label = (dollars) => "$" + dollars.toFixed(2);
`;

/** A Decimal-typed change (decimal.js / Prisma Decimal). */
const DECIMAL_DIFF = `diff --git a/src/price.ts b/src/price.ts
--- a/src/price.ts
+++ b/src/price.ts
@@ -1,3 +1,5 @@
+import Decimal from "decimal.js";
+export function lineTotal(unit: Decimal, qty: number): Decimal {
+  return new Decimal(unit).times(qty).toDecimalPlaces(2);
+}
`;

/** A native bigint change. */
const BIGINT_DIFF = `diff --git a/src/price.ts b/src/price.ts
--- a/src/price.ts
+++ b/src/price.ts
@@ -1,2 +1,3 @@
+export function lineTotal(unit: bigint, qty: bigint): bigint {
+  return unit * qty + 100n;
+}
`;

/** A change that touches no money handling at all. */
const NO_MONEY_DIFF = `diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1,1 +1,2 @@
+Updated the project description and fixed a typo in the header.
`;

const EMPTY_DIFF = "";

function step(diff: string, over: Partial<FinalStep> = {}): FinalStep {
  return { diff, metrics: { wallMs: 1_000 }, timedOut: false, ...over };
}

// helping variant: integer-cents is correct, migrating to Decimal is the trap.
const HELPING: AnchorConfig = {
  kind: "money-cents",
  correctConvention: "integer-cents",
  trapConvention: "decimal",
};

// poison variant: the code migrated to Decimal, so integer-cents is now the trap.
const POISON: AnchorConfig = {
  kind: "money-cents",
  correctConvention: "decimal",
  trapConvention: "integer-cents",
};

// --- classifier --------------------------------------------------------------

test("classifyMoneyConvention picks the adopted convention with evidence", () => {
  assert.equal(classifyMoneyConvention(INTEGER_CENTS_DIFF).convention, "integer-cents");
  assert.equal(classifyMoneyConvention(PARSE_FLOAT_DIFF).convention, "float");
  assert.equal(classifyMoneyConvention(TOFIXED_DIFF).convention, "float");
  assert.equal(classifyMoneyConvention(DECIMAL_DIFF).convention, "decimal");
  assert.equal(classifyMoneyConvention(BIGINT_DIFF).convention, "bigint");
  assert.equal(classifyMoneyConvention(NO_MONEY_DIFF).convention, "unknown");
  assert.equal(classifyMoneyConvention(EMPTY_DIFF).convention, "unknown");
});

test("Decimal/bigint type adoption wins over a float literal in the constructor", () => {
  const decimalFromFloat = `+const price = new Decimal(1.99);`;
  assert.equal(classifyMoneyConvention(decimalFromFloat).convention, "decimal");
  const bigintFromExpr = `+const cents: bigint = BigInt(Math.round(dollars));`;
  assert.equal(classifyMoneyConvention(bigintFromExpr).convention, "bigint");
});

// Regression tests for the code-review hardening ---------------------------

test("canonical integer-cents idioms with * 100 / 100 are NOT float", () => {
  // `Math.round(dollars * 100)` (adopt cents) and `totalCents / 100` (display)
  // are the textbook integer-cents idioms; they must not classify as float.
  const adopt = `+const amountCents = Math.round(dollars * 100);`;
  assert.equal(classifyMoneyConvention(adopt).convention, "integer-cents");
  const display = `+const dollars = totalCents / 100;`;
  assert.equal(classifyMoneyConvention(display).convention, "integer-cents");
});

test("a semver version bump is not mistaken for a money float literal", () => {
  const versionBump = `+  "vitest": "^1.2.3",`;
  assert.equal(classifyMoneyConvention(versionBump).convention, "unknown");
});

test("cents lookalikes (accents/recents/percents) do not classify as integer-cents", () => {
  const lookalikes = `+// normalize recent accents and percents in the label`;
  assert.equal(classifyMoneyConvention(lookalikes).convention, "unknown");
});

test("Decimal.js method idiom (no `Decimal` by name) classifies as decimal", () => {
  // A migrated `type Money = Decimal` codebase: a correct solution chains
  // Decimal methods on the alias without ever writing `Decimal`.
  const aliasIdiom = `+export function applyDiscount(cart: Cart, pct: number): Money {\n+  return subtotal(cart).times(1 - pct / 100);\n+}`;
  assert.equal(classifyMoneyConvention(aliasIdiom).convention, "decimal");
});

test("extractAddedLines takes + lines but not the +++ header", () => {
  const lines = extractAddedLines(PARSE_FLOAT_DIFF);
  assert.ok(lines.some((l) => l.includes("parseFloat(amount)")));
  assert.ok(!lines.some((l) => l.startsWith("+")));
  assert.ok(!lines.some((l) => l.includes("b/src/price.ts")));
});

// --- detector: helping variant (correct=integer-cents, trap=decimal) --------

test("helping: integer-cents diff holds, no trap", () => {
  const r = detectAnchor(HELPING, step(INTEGER_CENTS_DIFF, { metrics: { wallMs: 1_000, numTurns: 4 } }));
  assert.equal(r.conventionHeld, true);
  assert.equal(r.hitKnownTrap, false);
  assert.equal(r.turnsToGreen, 4);
  assert.match(r.evidence, /held integer-cents/);
});

test("helping: parseFloat diff fails, and float is not the (decimal) trap", () => {
  const r = detectAnchor(HELPING, step(PARSE_FLOAT_DIFF));
  assert.equal(r.conventionHeld, false);
  assert.equal(r.hitKnownTrap, false);
  assert.equal(r.turnsToGreen, undefined);
  assert.match(r.evidence, /float money/);
  assert.match(r.evidence, /expected integer-cents/);
});

test("helping: Decimal diff fails AND hits the known trap", () => {
  const r = detectAnchor(HELPING, step(DECIMAL_DIFF));
  assert.equal(r.conventionHeld, false);
  assert.equal(r.hitKnownTrap, true);
  assert.match(r.evidence, /known trap/);
});

// --- detector: poison variant (correct=decimal, trap=integer-cents) ---------

test("poison: Decimal diff holds, no trap", () => {
  const r = detectAnchor(POISON, step(DECIMAL_DIFF, { metrics: { wallMs: 1_000, numTurns: 9 } }));
  assert.equal(r.conventionHeld, true);
  assert.equal(r.hitKnownTrap, false);
  assert.equal(r.turnsToGreen, 9);
  assert.match(r.evidence, /held decimal/);
});

test("poison: stale integer-cents diff fails AND hits the known trap", () => {
  const r = detectAnchor(POISON, step(INTEGER_CENTS_DIFF));
  assert.equal(r.conventionHeld, false);
  assert.equal(r.hitKnownTrap, true);
  assert.match(r.evidence, /integer cents, expected decimal — known trap/);
});

// --- edges -------------------------------------------------------------------

test("no money change fails closed with the explicit evidence, no silent pass", () => {
  for (const cfg of [HELPING, POISON]) {
    const r = detectAnchor(cfg, step(NO_MONEY_DIFF));
    assert.equal(r.conventionHeld, false);
    assert.equal(r.hitKnownTrap, false);
    assert.equal(r.turnsToGreen, undefined);
    assert.equal(r.evidence, "no money-handling change detected on anchored step");
  }
});

test("empty diff fails closed", () => {
  const r = detectAnchor(HELPING, step(EMPTY_DIFF));
  assert.equal(r.conventionHeld, false);
  assert.equal(r.evidence, "no money-handling change detected on anchored step");
});

test("turnsToGreen is unset when held but numTurns is absent", () => {
  const r = detectAnchor(HELPING, step(INTEGER_CENTS_DIFF));
  assert.equal(r.conventionHeld, true);
  assert.equal(r.turnsToGreen, undefined);
});

test("timeout is reflected in evidence", () => {
  const held = detectAnchor(HELPING, step(INTEGER_CENTS_DIFF, { timedOut: true }));
  assert.match(held.evidence, /executor timed out/);

  const noChange = detectAnchor(HELPING, step(EMPTY_DIFF, { timedOut: true }));
  assert.match(noChange.evidence, /executor timed out/);
});
