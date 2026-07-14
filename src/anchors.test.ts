import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyMoneyConvention,
  detectAnchor,
  detectAnchorGraded,
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

// --- detector: rule (arbitrary required/forbidden diff-signal conjunction) ----

// Convention: format money with Intl, never a date/time lib as a money helper.
const INTL_RULE: AnchorConfig = {
  kind: "rule",
  label: "format money with Intl",
  required: ["Intl\\."],
  forbidden: ["date-fns|dayjs|moment"],
};

// Convention: mint ids via the shared newId(), never crypto.randomUUID directly.
const ID_RULE: AnchorConfig = {
  kind: "rule",
  label: "mint ids via newId()",
  required: ["newId\\("],
  forbidden: ["\\brandomUUID\\b"],
};

/** Satisfies INTL_RULE: uses Intl, no banned date lib. */
const INTL_HELD_DIFF = `diff --git a/src/money.ts b/src/money.ts
--- a/src/money.ts
+++ b/src/money.ts
@@ -1,2 +1,4 @@
+export function format(cents: number): string {
+  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
+}
`;

/**
 * Trips INTL_RULE's trap: satisfies the required `Intl.` marker but ALSO pulls in
 * a forbidden date lib — isolates the forbidden branch (required is present, so
 * the verdict fails on the trap, not on a missing marker).
 */
const INTL_TRAP_DIFF = `diff --git a/src/money.ts b/src/money.ts
--- a/src/money.ts
+++ b/src/money.ts
@@ -1,2 +1,4 @@
+import dayjs from "dayjs";
+export function format(cents: number): string {
+  return new Intl.NumberFormat("en-US").format(cents / 100) + dayjs().format();
+}
`;

test("rule: required present and no forbidden holds, turnsToGreen from numTurns", () => {
  const r = detectAnchor(
    INTL_RULE,
    step(INTL_HELD_DIFF, { metrics: { wallMs: 1_000, numTurns: 6 } }),
  );
  assert.equal(r.conventionHeld, true);
  assert.equal(r.hitKnownTrap, false);
  assert.equal(r.turnsToGreen, 6);
  assert.match(r.evidence, /held rule/);
  assert.match(r.evidence, /format money with Intl/);
});

test("rule: a missing required marker fails, evidence names it", () => {
  // Uses newId() nowhere — the required marker is absent.
  const noNewId = `diff --git a/src/thing.ts b/src/thing.ts
+++ b/src/thing.ts
@@ -1 +1,2 @@
+const id = String(counter++);
`;
  const r = detectAnchor(ID_RULE, step(noNewId));
  assert.equal(r.conventionHeld, false);
  assert.equal(r.hitKnownTrap, false);
  assert.equal(r.turnsToGreen, undefined);
  assert.match(r.evidence, /required \/newId\\\(\//);
});

test("rule: a forbidden marker present fails AND sets hitKnownTrap, evidence names it", () => {
  const r = detectAnchor(INTL_RULE, step(INTL_TRAP_DIFF));
  assert.equal(r.conventionHeld, false);
  assert.equal(r.hitKnownTrap, true);
  assert.equal(r.turnsToGreen, undefined);
  assert.match(r.evidence, /forbidden \/date-fns\|dayjs\|moment\/ present — known trap/);
});

test("rule: required/forbidden markers appearing only in a COMMENT do not count", () => {
  // Required `newId(` and forbidden `randomUUID` both live ONLY in comments, so
  // extractAddedLines strips them: the required is absent (not held) and the
  // forbidden is NOT tripped (no trap) — the verdict is driven by CODE alone.
  const commentOnly = `diff --git a/src/thing.ts b/src/thing.ts
+++ b/src/thing.ts
@@ -1 +1,3 @@
+// prefer newId() over crypto.randomUUID here
+const id = String(counter++);
`;
  const r = detectAnchor(ID_RULE, step(commentOnly));
  assert.equal(r.conventionHeld, false);
  assert.equal(r.hitKnownTrap, false);
  assert.match(r.evidence, /required \/newId\\\(\//);

  // And a forbidden marker only in a comment does NOT trip the trap while the
  // required marker IS present in code ⇒ the rule holds.
  const forbiddenInComment = `diff --git a/src/thing.ts b/src/thing.ts
+++ b/src/thing.ts
@@ -1 +1,3 @@
+// do not use crypto.randomUUID
+const id = newId();
`;
  const held = detectAnchor(ID_RULE, step(forbiddenInComment));
  assert.equal(held.conventionHeld, true);
  assert.equal(held.hitKnownTrap, false);
});

test("rule: a malformed regex source fails closed without throwing", () => {
  const bad: AnchorConfig = {
    kind: "rule",
    label: "bad pattern",
    required: ["Intl\\."],
    forbidden: ["("], // unterminated group
  };
  let r: ReturnType<typeof detectAnchor> | undefined;
  assert.doesNotThrow(() => {
    r = detectAnchor(bad, step(INTL_HELD_DIFF));
  });
  assert.equal(r?.conventionHeld, false);
  assert.equal(r?.hitKnownTrap, false);
  assert.match(r!.evidence, /invalid rule pattern/);
});

test("rule: empty required is vacuously held, empty forbidden means no trap", () => {
  const r = detectAnchor({ kind: "rule" }, step(INTL_HELD_DIFF));
  assert.equal(r.conventionHeld, true);
  assert.equal(r.hitKnownTrap, false);
});

// --- graded detector: rule (linkDiff vs cumulativeDiff, appliesIf) -----------

// Convention: ids use the ulid_ format, never crypto.randomUUID. `appliesIf`
// marks the surface that exercises the rule: the link mints/assigns an id.
const ULID_RULE: AnchorConfig = {
  kind: "rule",
  label: "ids use ulid_ format",
  required: ["ulid_"],
  forbidden: ["\\brandomUUID\\b"],
  appliesIf: ["\\bid\\b", "generateId\\("],
};

/** Re-emits the convention literally: mints an id with the ulid_ prefix. */
const ULID_LITERAL_DIFF = `diff --git a/src/user.ts b/src/user.ts
--- a/src/user.ts
+++ b/src/user.ts
@@ -1,2 +1,3 @@
+const id = "ulid_" + crockford(randomBytes(16));
`;

/** Exercises the rule (mints an id) but only CALLS a helper — no ulid_ literal. */
const ULID_VIA_HELPER_DIFF = `diff --git a/src/order.ts b/src/order.ts
--- a/src/order.ts
+++ b/src/order.ts
@@ -1,2 +1,3 @@
+const id = generateId();
`;

/** An earlier link built the helper: the ulid_ literal lives in the chain diff. */
const CUMULATIVE_HELPER_DIFF = `diff --git a/src/ids.ts b/src/ids.ts
--- a/src/ids.ts
+++ b/src/ids.ts
@@ -1,2 +1,4 @@
+export function generateId(): string {
+  return "ulid_" + crockford(randomBytes(16));
+}
`;

/** Never touches ids at all — the rule's surface is not exercised. */
const NO_ID_SURFACE_DIFF = `diff --git a/src/format.ts b/src/format.ts
--- a/src/format.ts
+++ b/src/format.ts
@@ -1,2 +1,3 @@
+export function formatLabel(name: string): string {
+  return name.trim().toUpperCase();
+}
`;

/** Mints an id but with neither the ulid_ literal nor the forbidden API. */
const ULID_DRIFT_DIFF = `diff --git a/src/session.ts b/src/session.ts
--- a/src/session.ts
+++ b/src/session.ts
@@ -1,2 +1,3 @@
+const id = uuidv4();
`;

/** Trips the trap AND carries the required literal in the same link. */
const ULID_TRAP_AND_LITERAL_DIFF = `diff --git a/src/user.ts b/src/user.ts
--- a/src/user.ts
+++ b/src/user.ts
@@ -1,2 +1,3 @@
+const id = "ulid_" + crypto.randomUUID();
`;

/** An earlier link sinned (randomUUID), captured only in the cumulative diff. */
const CUMULATIVE_WITH_FORBIDDEN_DIFF = `diff --git a/src/legacy.ts b/src/legacy.ts
--- a/src/legacy.ts
+++ b/src/legacy.ts
@@ -1,2 +1,3 @@
+const traceId = crypto.randomUUID();
`;

test("graded rule: literal hold — required matched in the link's own diff", () => {
  const r = detectAnchorGraded(ULID_RULE, step(ULID_LITERAL_DIFF, { metrics: { wallMs: 1_000, numTurns: 4 } }), {
    linkDiff: ULID_LITERAL_DIFF,
  });
  assert.equal(r.grade, "held-by-literal");
  assert.equal(r.conventionHeld, true);
  assert.equal(r.hitKnownTrap, false);
  assert.equal(r.turnsToGreen, 4);
  assert.match(r.evidence, /held-by-literal/);
  assert.match(r.evidence, /required \(\/ulid_\/\) matched link-diff/);
});

test("graded rule: abstraction hold — required in the cumulative diff WITH linkage evidence", () => {
  // The link calls generateId(), the helper defined next to the ulid_ marker in
  // the cumulative diff — that identifier reuse is the required link-level
  // evidence for the strongest grade.
  const r = detectAnchorGraded(ULID_RULE, step(ULID_VIA_HELPER_DIFF), {
    linkDiff: ULID_VIA_HELPER_DIFF,
    cumulativeDiff: CUMULATIVE_HELPER_DIFF,
  });
  assert.equal(r.grade, "held-by-abstraction");
  assert.equal(r.conventionHeld, true);
  assert.equal(r.hitKnownTrap, false);
  assert.match(r.evidence, /held-by-abstraction/);
  assert.match(r.evidence, /\/ulid_\/ absent from link diff/);
  assert.match(r.evidence, /matched cumulative-diff/);
  assert.match(r.evidence, /linkage via identifier "generateId"/, "evidence names the linking identifier");
});

test("graded rule: cumulative hold WITHOUT linkage grades drift when the link exercised the surface", () => {
  // The rev_/Math.random repro: the link mints an id (appliesIf matches) using a
  // wrong-way scheme; the ulid_ marker exists only in an earlier link's diff and
  // NOTHING from that marker's context is reused here. Inheriting
  // held-by-abstraction would credit genuine drift — this must grade drift.
  const revDriftDiff = `diff --git a/src/revision.ts b/src/revision.ts
--- a/src/revision.ts
+++ b/src/revision.ts
@@ -1,2 +1,3 @@
+const id = "rev_" + Math.random().toString(36).slice(2, 10);
`;
  const r = detectAnchorGraded(ULID_RULE, step(revDriftDiff), {
    linkDiff: revDriftDiff,
    cumulativeDiff: CUMULATIVE_HELPER_DIFF,
  });
  assert.equal(r.grade, "drift");
  assert.equal(r.conventionHeld, false);
  assert.equal(r.hitKnownTrap, false);
  assert.match(r.evidence, /no linkage identifier/);
  assert.match(r.evidence, /appliesIf matched/);
});

test("graded rule: cumulative hold WITHOUT linkage and WITHOUT appliesIf grades held-by-chain", () => {
  // Convention persists chain-wide, but with no applicability signal and no
  // identifier reuse the detector cannot adjudicate THIS link — honest weak
  // label, conventionHeld true, never the top grade.
  const noAppliesIf: AnchorConfig = {
    kind: "rule",
    label: "ids use ulid_ format",
    required: ["ulid_"],
    forbidden: ["\\brandomUUID\\b"],
  };
  const r = detectAnchorGraded(noAppliesIf, step(NO_ID_SURFACE_DIFF), {
    linkDiff: NO_ID_SURFACE_DIFF,
    cumulativeDiff: CUMULATIVE_HELPER_DIFF,
  });
  assert.equal(r.grade, "held-by-chain");
  assert.equal(r.conventionHeld, true);
  assert.equal(r.hitKnownTrap, false);
  assert.match(r.evidence, /held-by-chain/);
  assert.match(r.evidence, /no linkage identifier/);
  assert.match(r.evidence, /no appliesIf/);
});

test("graded rule: linkage windows never cross a file boundary in the cumulative diff", () => {
  // The ulid_ marker lives in file A; the helper the link reuses is defined in
  // file B. Identifiers from B must not be harvested from A's marker window, so
  // there is no linkage — with appliesIf matched this is drift, not abstraction.
  const splitFilesCumulative = `diff --git a/src/ids.ts b/src/ids.ts
--- a/src/ids.ts
+++ b/src/ids.ts
@@ -1,1 +1,2 @@
+export const ID_PREFIX = "ulid_";
diff --git a/src/other.ts b/src/other.ts
--- a/src/other.ts
+++ b/src/other.ts
@@ -1,1 +1,3 @@
+export function mintSession(): string {
+  return sessionSuffix();
+}
`;
  const linkDiff = `diff --git a/src/session.ts b/src/session.ts
--- a/src/session.ts
+++ b/src/session.ts
@@ -1,1 +1,2 @@
+const id = mintSession();
`;
  const r = detectAnchorGraded(ULID_RULE, step(linkDiff), {
    linkDiff,
    cumulativeDiff: splitFilesCumulative,
  });
  assert.equal(r.grade, "drift");
  assert.equal(r.conventionHeld, false);
});

test("graded rule: an EMPTY link diff never inherits a cumulative hold — unknown (fail closed)", () => {
  // Previously an empty link diff fell through to held-by-abstraction once the
  // marker existed anywhere earlier in the chain. Rule 4 now fails closed first.
  const noAppliesIf: AnchorConfig = { kind: "rule", required: ["ulid_"] };
  const r = detectAnchorGraded(noAppliesIf, step(EMPTY_DIFF), {
    linkDiff: EMPTY_DIFF,
    cumulativeDiff: CUMULATIVE_HELPER_DIFF,
  });
  assert.equal(r.grade, "unknown");
  assert.equal(r.conventionHeld, false);
  assert.match(r.evidence, /no added lines/);
});

test("graded rule: inertia — appliesIf unmatched, required nowhere", () => {
  const r = detectAnchorGraded(ULID_RULE, step(NO_ID_SURFACE_DIFF), {
    linkDiff: NO_ID_SURFACE_DIFF,
  });
  assert.equal(r.grade, "held-by-inertia");
  assert.equal(r.conventionHeld, true);
  assert.equal(r.hitKnownTrap, false);
  assert.match(r.evidence, /held-by-inertia/);
  assert.match(r.evidence, /no appliesIf/);
  assert.match(r.evidence, /never exercised/);
});

test("graded rule: inertia takes precedence over abstraction (unexercised link is not credited via the chain)", () => {
  // appliesIf unmatched in this link, BUT the cumulative diff contains the
  // required marker — the earlier-built helper must not upgrade a link that
  // never faced the rule.
  const r = detectAnchorGraded(ULID_RULE, step(NO_ID_SURFACE_DIFF), {
    linkDiff: NO_ID_SURFACE_DIFF,
    cumulativeDiff: CUMULATIVE_HELPER_DIFF,
  });
  assert.equal(r.grade, "held-by-inertia");
  assert.equal(r.conventionHeld, true);
});

test("graded rule: trap beats literal — forbidden AND required both in the link diff", () => {
  const r = detectAnchorGraded(ULID_RULE, step(ULID_TRAP_AND_LITERAL_DIFF), {
    linkDiff: ULID_TRAP_AND_LITERAL_DIFF,
  });
  assert.equal(r.grade, "trap");
  assert.equal(r.conventionHeld, false);
  assert.equal(r.hitKnownTrap, true);
  assert.equal(r.turnsToGreen, undefined);
  assert.match(r.evidence, /trap/);
  assert.match(r.evidence, /forbidden \/\\brandomUUID\\b\/ matched link-diff/);
});

test("graded rule: drift — surface exercised, required absent everywhere", () => {
  const withCumulative = detectAnchorGraded(ULID_RULE, step(ULID_DRIFT_DIFF), {
    linkDiff: ULID_DRIFT_DIFF,
    cumulativeDiff: ULID_DRIFT_DIFF,
  });
  assert.equal(withCumulative.grade, "drift");
  assert.equal(withCumulative.conventionHeld, false);
  assert.equal(withCumulative.hitKnownTrap, false);
  assert.match(withCumulative.evidence, /drift/);
  assert.match(withCumulative.evidence, /required \/ulid_\/ absent from link diff and cumulative diff/);

  const withoutCumulative = detectAnchorGraded(ULID_RULE, step(ULID_DRIFT_DIFF), {
    linkDiff: ULID_DRIFT_DIFF,
  });
  assert.equal(withoutCumulative.grade, "drift");
  assert.match(withoutCumulative.evidence, /absent from link diff(?! and)/);
});

test("graded rule: empty linkDiff is unknown (fail closed) when no appliesIf guards it", () => {
  const noAppliesIf: AnchorConfig = { kind: "rule", required: ["ulid_"] };
  const r = detectAnchorGraded(noAppliesIf, step(EMPTY_DIFF), { linkDiff: EMPTY_DIFF });
  assert.equal(r.grade, "unknown");
  assert.equal(r.conventionHeld, false);
  assert.equal(r.hitKnownTrap, false);
  assert.match(r.evidence, /unknown/);
  assert.match(r.evidence, /no added lines/);

  // Corollary of the EXACT precedence order: with appliesIf present, an empty
  // link diff grades inertia (nothing matched the surface — vacuous hold)
  // before the empty-diff check is ever reached.
  const withAppliesIf = detectAnchorGraded(ULID_RULE, step(EMPTY_DIFF), { linkDiff: EMPTY_DIFF });
  assert.equal(withAppliesIf.grade, "held-by-inertia");
});

test("graded rule: forbidden only in cumulative, required in link → still held-by-literal", () => {
  // Per-link grading ignores inherited cumulative sins: forbidden is only ever
  // tested against the link's own diff.
  const r = detectAnchorGraded(ULID_RULE, step(ULID_LITERAL_DIFF), {
    linkDiff: ULID_LITERAL_DIFF,
    cumulativeDiff: CUMULATIVE_WITH_FORBIDDEN_DIFF,
  });
  assert.equal(r.grade, "held-by-literal");
  assert.equal(r.conventionHeld, true);
  assert.equal(r.hitKnownTrap, false);
});

test("graded rule: empty required is vacuously held-by-literal when the link is clean", () => {
  const forbiddenOnly: AnchorConfig = { kind: "rule", forbidden: ["\\brandomUUID\\b"] };
  const r = detectAnchorGraded(forbiddenOnly, step(ULID_DRIFT_DIFF), { linkDiff: ULID_DRIFT_DIFF });
  assert.equal(r.grade, "held-by-literal");
  assert.equal(r.conventionHeld, true);
  assert.match(r.evidence, /vacuously satisfied/);
});

test("graded rule: a malformed regex source grades unknown without throwing", () => {
  const bad: AnchorConfig = { kind: "rule", required: ["("] };
  let r: ReturnType<typeof detectAnchorGraded> | undefined;
  assert.doesNotThrow(() => {
    r = detectAnchorGraded(bad, step(ULID_LITERAL_DIFF), { linkDiff: ULID_LITERAL_DIFF });
  });
  assert.equal(r?.grade, "unknown");
  assert.equal(r?.conventionHeld, false);
  assert.match(r!.evidence, /invalid rule pattern/);
});

// --- graded detector: non-rule kinds map onto grades, detection unchanged ----

test("graded registry: held maps to held-by-literal, miss maps to drift", () => {
  const held = detectAnchorGraded(REGISTRY, step(REGISTRY_TOUCHED_DIFF), {
    linkDiff: REGISTRY_TOUCHED_DIFF,
  });
  assert.equal(held.grade, "held-by-literal");
  assert.equal(held.conventionHeld, true);

  const missed = detectAnchorGraded(REGISTRY, step(REGISTRY_MISSED_DIFF), {
    linkDiff: REGISTRY_MISSED_DIFF,
  });
  assert.equal(missed.grade, "drift");
  assert.equal(missed.conventionHeld, false);
});

test("graded money-cents: literal / trap / drift / unknown mapping", () => {
  const literal = detectAnchorGraded(HELPING, step(INTEGER_CENTS_DIFF), { linkDiff: INTEGER_CENTS_DIFF });
  assert.equal(literal.grade, "held-by-literal");

  const trap = detectAnchorGraded(HELPING, step(DECIMAL_DIFF), { linkDiff: DECIMAL_DIFF });
  assert.equal(trap.grade, "trap");
  assert.equal(trap.hitKnownTrap, true);

  const drift = detectAnchorGraded(HELPING, step(PARSE_FLOAT_DIFF), { linkDiff: PARSE_FLOAT_DIFF });
  assert.equal(drift.grade, "drift");

  // The classifier's indeterminate path (no money signal) fails closed as unknown.
  const unknown = detectAnchorGraded(HELPING, step(NO_MONEY_DIFF), { linkDiff: NO_MONEY_DIFF });
  assert.equal(unknown.grade, "unknown");
  assert.equal(unknown.conventionHeld, false);
});

test("graded setup-gotcha: absent trace is unknown, reactive trap hit is trap", () => {
  const noTrace = detectAnchorGraded(GOTCHA, step(""), { linkDiff: "" });
  assert.equal(noTrace.grade, "unknown");

  const trapped = detectAnchorGraded(GOTCHA, step("", { trace: TRACE_HIT_TRAP }), { linkDiff: "" });
  assert.equal(trapped.grade, "trap");
});

test("graded detector leaves legacy fields identical to detectAnchor for non-rule kinds", () => {
  const cases: Array<[AnchorConfig, FinalStep]> = [
    [HELPING, step(INTEGER_CENTS_DIFF, { metrics: { wallMs: 1_000, numTurns: 4 } })],
    [HELPING, step(DECIMAL_DIFF)],
    [REGISTRY, step(REGISTRY_MISSED_DIFF)],
    [GOTCHA, step("", { trace: TRACE_RAN_SETUP, metrics: { wallMs: 1_000, numTurns: 2 } })],
  ];
  for (const [cfg, s] of cases) {
    const legacy = detectAnchor(cfg, s);
    const graded = detectAnchorGraded(cfg, s, { linkDiff: s.diff });
    assert.equal(legacy.grade, undefined, "legacy API must not emit a grade");
    assert.notEqual(graded.grade, undefined, "graded API must always emit a grade");
    assert.deepEqual(
      {
        conventionHeld: graded.conventionHeld,
        hitKnownTrap: graded.hitKnownTrap,
        evidence: graded.evidence,
        turnsToGreen: graded.turnsToGreen,
      },
      {
        conventionHeld: legacy.conventionHeld,
        hitKnownTrap: legacy.hitKnownTrap,
        evidence: legacy.evidence,
        turnsToGreen: legacy.turnsToGreen,
      },
    );
  }
});
