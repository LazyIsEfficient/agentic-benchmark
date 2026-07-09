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

test("a $ float in a COMMENT does not override integer-cents CODE (real-run bug)", () => {
  // Reproduces the memory-cents run: naked/gstack kept 599 cents but a
  // clarifying comment mentioning $5.99 flipped the verdict to float.
  const nakedCase = `+  // subtotal 3648 + flat fee 599 ($5.99)\n+  const FLAT_SHIPPING_FEE = 599;\n+  return subtotalCents(items) + FLAT_SHIPPING_FEE;`;
  assert.equal(classifyMoneyConvention(nakedCase).convention, "integer-cents");
  const gstackCase = `+  // Flat shipping fee of $5.99, in cents (matches the module's cents convention).\n+  const FLAT_SHIPPING_FEE = 599;\n+  return subtotalCents(items) + FLAT_SHIPPING_FEE;`;
  assert.equal(classifyMoneyConvention(gstackCase).convention, "integer-cents");
});

test("a bare integer whose cents-ness lives ONLY in a comment is unknown, not float", () => {
  // Honest limitation: with the comment stripped, `599` alone carries no code
  // signal that it is cents. Fails CLOSED (unknown → not held), never a false
  // float verdict — the failure mode that mattered.
  const bare = `+  // $5.99 flat fee, in cents\n+  const FLAT_SHIPPING_FEE = 599;`;
  assert.equal(classifyMoneyConvention(bare).convention, "unknown");
});

test("a $ float in a JSDoc line is ignored", () => {
  const jsdoc = `+/**\n+ * Flat shipping fee, $5.99, stored as cents.\n+ */\n+const feeCents = 599;`;
  assert.equal(classifyMoneyConvention(jsdoc).convention, "integer-cents");
});

test("a genuine float literal in CODE still classifies as float", () => {
  // Comment stripping must not hide a real float in code.
  const realFloat = `+const fee = 5.99; // dollars`;
  assert.equal(classifyMoneyConvention(realFloat).convention, "float");
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

// --- detector: registry (arbitrary "register your export" rule) --------------

const REGISTRY: AnchorConfig = { kind: "registry", requiredFile: "src/registry.ts" };

/** A step-2 diff that touches the required registry file. */
const REGISTRY_TOUCHED_DIFF = `diff --git a/src/registry.ts b/src/registry.ts
--- a/src/registry.ts
+++ b/src/registry.ts
@@ -1,3 +1,4 @@
+export { widget } from "./widget.js";
`;

/** A step-2 diff that adds an export but ignores the registry file. */
const REGISTRY_MISSED_DIFF = `diff --git a/src/widget.ts b/src/widget.ts
--- a/src/widget.ts
+++ b/src/widget.ts
@@ -1,2 +1,3 @@
+export function widget() {}
`;

test("registry: diff touching src/registry.ts holds, no trap", () => {
  const r = detectAnchor(
    REGISTRY,
    step(REGISTRY_TOUCHED_DIFF, { metrics: { wallMs: 1_000, numTurns: 3 } }),
  );
  assert.equal(r.conventionHeld, true);
  assert.equal(r.hitKnownTrap, false);
  assert.equal(r.turnsToGreen, 3);
  assert.match(r.evidence, /modifies src\/registry\.ts/);
});

test("registry: diff not touching the registry file fails closed", () => {
  const r = detectAnchor(REGISTRY, step(REGISTRY_MISSED_DIFF));
  assert.equal(r.conventionHeld, false);
  assert.equal(r.hitKnownTrap, false);
  assert.equal(r.turnsToGreen, undefined);
  assert.match(r.evidence, /does not touch src\/registry\.ts/);
});

test("registry: empty diff fails closed", () => {
  const r = detectAnchor(REGISTRY, step(EMPTY_DIFF));
  assert.equal(r.conventionHeld, false);
  assert.equal(r.turnsToGreen, undefined);
});

test("registry: lookalike paths, rename-away, and delete do NOT count as held", () => {
  // Substring matching would false-positive on all of these; exact post-image
  // path matching must reject them.
  const lookalikeBak = `+++ b/src/registry.ts.bak\n@@ -1 +1,2 @@\n+noise`;
  const lookalikeTsx = `+++ b/src/registry.tsx\n@@ -1 +1,2 @@\n+noise`;
  const renameAway = `diff --git a/src/registry.ts b/src/other.ts\n--- a/src/registry.ts\n+++ b/src/other.ts\n@@ -1 +1 @@\n+moved`;
  const deletion = `diff --git a/src/registry.ts b/src/registry.ts\n--- a/src/registry.ts\n+++ /dev/null\n@@ -1 +0,0 @@`;
  for (const d of [lookalikeBak, lookalikeTsx, renameAway, deletion]) {
    assert.equal(detectAnchor(REGISTRY, step(d)).conventionHeld, false, `should not hold: ${d.split("\n")[0]}`);
  }
  // Sanity: an exact modification still holds.
  const exact = `+++ b/src/registry.ts\n@@ -1 +1,2 @@\n+export { x } from "./x.js";`;
  assert.equal(detectAnchor(REGISTRY, step(exact)).conventionHeld, true);
});

// --- detector: setup-gotcha (runtime-only knowledge) -------------------------

const GOTCHA: AnchorConfig = {
  kind: "setup-gotcha",
  setupSignal: "npm run gen-fixtures",
  trapSignal: "Cannot find .*fixtures\\.json",
};

/** A trace where the agent ran the required setup command. */
const TRACE_RAN_SETUP = JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm run gen-fixtures" } }] },
});

/** A trace where the agent hit the runtime failure. */
const TRACE_HIT_TRAP = JSON.stringify({
  type: "user",
  message: { content: [{ type: "tool_result", content: "Error: Cannot find ./data/fixtures.json" }] },
});

test("setup-gotcha: trace running the setup command holds", () => {
  const r = detectAnchor(
    GOTCHA,
    step("", { trace: TRACE_RAN_SETUP, metrics: { wallMs: 1_000, numTurns: 2 } }),
  );
  assert.equal(r.conventionHeld, true);
  assert.equal(r.hitKnownTrap, false);
  assert.equal(r.turnsToGreen, 2);
  assert.match(r.evidence, /proactively/);
});

test("setup-gotcha: trace with the trap signature sets hitKnownTrap", () => {
  const r = detectAnchor(GOTCHA, step("", { trace: TRACE_HIT_TRAP }));
  assert.equal(r.conventionHeld, false);
  assert.equal(r.hitKnownTrap, true);
  assert.equal(r.turnsToGreen, undefined);
  assert.match(r.evidence, /hit trap/);
});

test("setup-gotcha: hit trap THEN ran setup is REACTIVE, not held", () => {
  // A memoryless agent MUST run setup to go green — but reactively, after hitting
  // the failure. "Ran setup" alone doesn't discriminate memory; holding requires
  // NOT hitting the trap (i.e. proactive application from memory).
  const both = `${TRACE_HIT_TRAP}\n${TRACE_RAN_SETUP}`;
  const r = detectAnchor(
    GOTCHA,
    step("", { trace: both, metrics: { wallMs: 1_000, numTurns: 5 } }),
  );
  assert.equal(r.conventionHeld, false);
  assert.equal(r.hitKnownTrap, true);
  assert.equal(r.turnsToGreen, undefined);
  assert.match(r.evidence, /reactive/);
});

test("setup-gotcha: absent/empty trace fails closed with explicit evidence", () => {
  const absent = detectAnchor(GOTCHA, step(""));
  assert.equal(absent.conventionHeld, false);
  assert.equal(absent.hitKnownTrap, false);
  assert.match(absent.evidence, /no trace available/);

  const empty = detectAnchor(GOTCHA, step("", { trace: "" }));
  assert.equal(empty.conventionHeld, false);
  assert.match(empty.evidence, /no trace available/);
});

test("setup-gotcha: evidence never leaks the raw trace", () => {
  const r = detectAnchor(GOTCHA, step("", { trace: TRACE_RAN_SETUP }));
  assert.ok(!r.evidence.includes("tool_use"));
  assert.ok(!r.evidence.includes(TRACE_RAN_SETUP));
});

test("setup-gotcha: a malformed regex source fails closed without throwing", () => {
  const bad: AnchorConfig = {
    kind: "setup-gotcha",
    setupSignal: "npm run gen-fixtures",
    trapSignal: "Cannot find [", // unterminated character class
  };
  let r: ReturnType<typeof detectAnchor> | undefined;
  assert.doesNotThrow(() => {
    r = detectAnchor(bad, step("", { trace: TRACE_RAN_SETUP }));
  });
  assert.equal(r?.conventionHeld, false);
  assert.equal(r?.hitKnownTrap, false);
  assert.match(r!.evidence, /invalid setup-gotcha signal pattern/);
});
