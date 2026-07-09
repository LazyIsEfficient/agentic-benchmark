import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AnchorConfig,
  AnchorResult,
  MoneyCentsAnchor,
  TaskMeta,
} from "./types.js";

test("sequential TaskMeta constructs with steps + a helping money-cents anchor", () => {
  const helpingAnchor: MoneyCentsAnchor = {
    kind: "money-cents",
    correctConvention: "integer-cents",
    trapConvention: "decimal",
    evaluatedStepId: "reprice",
  };
  const meta: TaskMeta = {
    id: "seq-money",
    title: "Sequential repricing",
    logicBearing: true,
    securityRelevant: false,
    steps: [
      { id: "migrate", prompt: "Add a discount field." },
      { id: "reprice", prompt: "Recompute the cart total." },
    ],
    anchor: helpingAnchor,
  };

  assert.equal(meta.steps?.length, 2);
  assert.equal(meta.steps?.[0]?.id, "migrate");
  assert.equal(meta.anchor?.kind, "money-cents");
  // Round-trips as JSON (meta.json persistence).
  assert.deepEqual(JSON.parse(JSON.stringify(meta)), meta);
});

test("the poison money-cents anchor is expressible with the same shape", () => {
  // Poison: current code migrated to Decimal, so following it is correct and the
  // integer-cents baseline is now the trap. Same union member, inverted fields.
  const poisonAnchor: AnchorConfig = {
    kind: "money-cents",
    correctConvention: "decimal",
    trapConvention: "integer-cents",
  };
  assert.equal(poisonAnchor.kind, "money-cents");
  if (poisonAnchor.kind === "money-cents") {
    assert.equal(poisonAnchor.correctConvention, "decimal");
    assert.equal(poisonAnchor.trapConvention, "integer-cents");
  }
});

test("AnchorResult carries the deterministic verdict and serializes", () => {
  const held: AnchorResult = {
    conventionHeld: true,
    turnsToGreen: 2,
    hitKnownTrap: false,
    evidence: "final step returned an integer cents total (4200)",
  };
  const trapped: AnchorResult = {
    conventionHeld: false,
    hitKnownTrap: true,
    evidence: "adopted Decimal on the repricing step",
  };

  assert.equal(held.conventionHeld, true);
  assert.equal(held.turnsToGreen, 2);
  assert.equal(trapped.turnsToGreen, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(held)), held);
});

test("a single-prompt TaskMeta still typechecks with no steps or anchor", () => {
  const meta: TaskMeta = {
    id: "single",
    title: "One-shot task",
    logicBearing: false,
    securityRelevant: false,
  };
  assert.equal(meta.steps, undefined);
  assert.equal(meta.anchor, undefined);
});
