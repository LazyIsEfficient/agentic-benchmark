import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AnchorConfig,
  AnchorResult,
  CallMetrics,
  CampaignResult,
  CampaignTaskResult,
  MoneyCentsAnchor,
  RuleAnchor,
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
  assert.equal(meta.campaign, undefined);
});

test("a RuleAnchor is a member of the AnchorConfig union", () => {
  const rule: RuleAnchor = {
    kind: "rule",
    label: "routes through the shared logger",
    required: ["\\bgetLogger\\s*\\(", "logger\\.info\\("],
    forbidden: ["console\\.log\\("],
  };
  // Assignable to the widened union.
  const asConfig: AnchorConfig = rule;
  assert.equal(asConfig.kind, "rule");
  if (asConfig.kind === "rule") {
    assert.equal(asConfig.required?.length, 2);
    assert.equal(asConfig.forbidden?.[0], "console\\.log\\(");
  }
  assert.deepEqual(JSON.parse(JSON.stringify(rule)), rule);
});

test("a TaskMeta with a 5-link campaign (incl. a rule anchor) typechecks + serializes", () => {
  const meta: TaskMeta = {
    id: "campaign-logger",
    title: "Longitudinal logger campaign",
    logicBearing: true,
    securityRelevant: false,
    campaign: [
      { id: "scaffold", prompt: "Create the service skeleton." },
      { id: "add-endpoint", prompt: "Add a /health endpoint." },
      {
        id: "add-logging",
        prompt: "Add request logging.",
        anchor: {
          kind: "registry",
          requiredFile: "src/registry.ts",
        },
      },
      { id: "refactor", prompt: "Extract the handler into its own module." },
      {
        id: "reuse-logger",
        prompt: "Log the new module's errors the project way.",
        anchor: {
          kind: "rule",
          label: "reuses the shared logger, never console",
          required: ["getLogger\\("],
          forbidden: ["console\\.(log|error)\\("],
        },
      },
    ],
  };

  assert.equal(meta.campaign?.length, 5);
  assert.equal(meta.campaign?.[4]?.anchor?.kind, "rule");
  assert.equal(meta.campaign?.[2]?.id, "add-logging");
  // Round-trips as JSON (meta.json persistence).
  assert.deepEqual(JSON.parse(JSON.stringify(meta)), meta);
});

test("CampaignTaskResult and CampaignResult carry a trajectory and serialize", () => {
  const metrics: CallMetrics = { wallMs: 42_000, numTurns: 3 };
  const link: CampaignTaskResult = {
    taskId: "reuse-logger",
    index: 4,
    score: 88,
    anchors: {
      conventionHeld: true,
      turnsToGreen: 1,
      hitKnownTrap: false,
      evidence: "diff calls getLogger(), no console.* present",
    },
    metrics,
  };
  const failed: CampaignTaskResult = {
    taskId: "refactor",
    index: 3,
    metrics: { wallMs: 5_000 },
    failure: "executor timed out",
  };
  const campaign: CampaignResult = {
    variant: "agentic-os",
    executorModel: "sonnet",
    campaignId: "campaign-logger",
    tasks: [link, failed],
  };

  assert.equal(campaign.tasks.length, 2);
  assert.equal(campaign.tasks[0]?.score, 88);
  assert.equal(campaign.tasks[0]?.anchors?.conventionHeld, true);
  assert.equal(campaign.tasks[1]?.score, undefined);
  assert.equal(campaign.tasks[1]?.failure, "executor timed out");
  assert.deepEqual(JSON.parse(JSON.stringify(campaign)), campaign);
});
