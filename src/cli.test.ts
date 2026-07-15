import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  MAX_CONCURRENCY,
  buildCells,
  buildPairJobs,
  formatTestResultsSummary,
  formatVariantListLine,
  loadTasks,
  loadVariants,
  parseConcurrency,
  parseDelayMs,
  parseModels,
  parseRepeats,
  resultSortComparator,
  runCampaignCell,
  runCell,
  type Cell,
  type CollectedDiff,
  type CellDiffContext,
  type CellDiffKey,
  type RunCampaignDeps,
  type RunCellDeps,
} from "./cli.js";
import { detectAnchorGraded } from "./anchors.js";
import type { CampaignTaskArtifacts } from "./executor.js";
import type { JudgeCellOutcome } from "./judge.js";
import type { CellJudgePromptInputs } from "./rubric.js";
import type {
  AnchorConfig,
  AnchorResult,
  BlastRadiusEntry,
  CellJudgeResult,
  CopyBundleVariant,
  CraftScore,
  RunArtifacts,
  SetupBundleVariant,
  SlopMetrics,
  Task,
  TaskMeta,
  Variant,
  VariantTaskResult,
} from "./types.js";

test("parseModels splits comma/space, trims, dedups, drops empties", () => {
  // Simulates `--models "fable, sonnet ,opus"` (one token).
  assert.deepEqual(parseModels(["fable, sonnet ,opus"], "sonnet"), [
    "fable",
    "sonnet",
    "opus",
  ]);
});

test("parseModels merges multiple --models flags and dedups across them", () => {
  assert.deepEqual(parseModels(["fable,sonnet", "opus", "fable"], "sonnet"), [
    "fable",
    "sonnet",
    "opus",
  ]);
});

test("parseModels falls back to the default when nothing valid is given", () => {
  assert.deepEqual(parseModels([], "sonnet"), ["sonnet"]);
  assert.deepEqual(parseModels(["", "  ", ","], "opus"), ["opus"]);
});

test("parseConcurrency: valid integers pass through", () => {
  assert.equal(parseConcurrency("1"), 1);
  assert.equal(parseConcurrency("3"), 3);
  assert.equal(parseConcurrency(" 5 "), 5);
});

test("parseConcurrency: missing → default 1", () => {
  assert.equal(parseConcurrency(undefined), 1);
});

test("parseConcurrency: zero, negative, and non-numeric throw", () => {
  assert.throws(() => parseConcurrency("0"), />= 1/);
  assert.throws(() => parseConcurrency("-2"), /positive integer|>= 1/);
  assert.throws(() => parseConcurrency("abc"), /positive integer/);
  assert.throws(() => parseConcurrency("2.5"), /positive integer/);
});

test("parseConcurrency: absurd values clamp to the max with a warning", () => {
  const warnings: string[] = [];
  const n = parseConcurrency("1000", (m) => warnings.push(m));
  assert.equal(n, MAX_CONCURRENCY);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /clamping/);
});

test("parseDelayMs: missing → 0 (no pacing)", () => {
  assert.equal(parseDelayMs(undefined), 0);
});

test("parseDelayMs: valid non-negative integers pass through", () => {
  assert.equal(parseDelayMs("0"), 0);
  assert.equal(parseDelayMs("500"), 500);
  assert.equal(parseDelayMs(" 1500 "), 1500);
});

test("parseDelayMs: negative and non-numeric throw", () => {
  assert.throws(() => parseDelayMs("-1"), />= 0|non-negative/);
  assert.throws(() => parseDelayMs("abc"), /non-negative integer/);
  assert.throws(() => parseDelayMs("2.5"), /non-negative integer/);
});

test("parseRepeats: missing → the provided fallback (config default)", () => {
  assert.equal(parseRepeats(undefined, 1), 1);
  assert.equal(parseRepeats(undefined, 3), 3);
});

test("parseRepeats: valid positive integers pass through", () => {
  assert.equal(parseRepeats("1"), 1);
  assert.equal(parseRepeats(" 4 "), 4);
});

test("parseRepeats: zero, negative, and non-numeric throw", () => {
  assert.throws(() => parseRepeats("0"), />= 1/);
  assert.throws(() => parseRepeats("-2"), /positive integer|>= 1/);
  assert.throws(() => parseRepeats("abc"), /positive integer/);
  assert.throws(() => parseRepeats("2.5"), /positive integer/);
});

test("formatTestResultsSummary: none / pass / fail / counted", () => {
  assert.equal(formatTestResultsSummary(undefined), "none");
  assert.equal(formatTestResultsSummary({ command: "npm t", ok: true }), "pass");
  assert.equal(formatTestResultsSummary({ command: "npm t", ok: false }), "fail");
  assert.equal(
    formatTestResultsSummary({ command: "npm t", ok: true, passed: 3, failed: 0 }),
    "pass (3p/0f)",
  );
  assert.equal(
    formatTestResultsSummary({ command: "npm t", ok: false, passed: 2, failed: 1 }),
    "fail (2p/1f)",
  );
  // A half-parsed count never renders a fabricated number.
  assert.equal(formatTestResultsSummary({ command: "npm t", ok: true, passed: 3 }), "pass");
});

// --- Variant loading (reads the real prompts/ corpus) -----------------------

test("loadVariants: naked variant loads with empty content as claude-md", async () => {
  const variants = await loadVariants();
  const naked = variants.find((v) => v.name === "naked");
  assert.ok(naked, "naked variant should be discovered");
  assert.equal(naked.type, "claude-md");
  assert.equal(naked.type === "claude-md" ? naked.content : "MISSING", "");
});

test("loadVariants: agentic-os loads as a copy bundle with resolved config paths", async () => {
  const variants = await loadVariants();
  const bundle = variants.find((v) => v.name === "agentic-os");
  assert.ok(bundle, "agentic-os variant should be discovered");
  assert.equal(bundle.type, "bundle");
  assert.ok(bundle.type === "bundle" && bundle.install === "copy");
  const b = bundle as CopyBundleVariant;
  assert.match(b.claudeMdPath, /prompts\/agentic-os\/CLAUDE\.md$/);
  assert.match(b.configDirPath, /prompts\/agentic-os\/claude$/);
  assert.match(b.description ?? "", /agentic-os v3\.0\.1/);
});

test("loadVariants: gstack loads as a setup bundle with a setupCommand", async () => {
  const variants = await loadVariants();
  const bundle = variants.find((v) => v.name === "gstack");
  assert.ok(bundle, "gstack variant should be discovered");
  assert.ok(bundle.type === "bundle" && bundle.install === "setup");
  const b = bundle as SetupBundleVariant;
  assert.match(b.claudeMdPath, /prompts\/gstack\/CLAUDE\.md$/);
  assert.match(b.setupCommand, /\/opt\/gstack\/setup --local/);
  assert.match(b.description ?? "", /gstack 1\.58\.5\.0/);
});

test("formatVariantListLine: shows the type (and description for bundles)", () => {
  assert.equal(
    formatVariantListLine({ name: "naked", type: "claude-md", content: "" }),
    "  - naked [claude-md]",
  );
  assert.equal(
    formatVariantListLine({
      name: "agentic-os",
      type: "bundle",
      install: "copy",
      claudeMdPath: "/x/CLAUDE.md",
      configDirPath: "/x/claude",
      description: "agentic-os v3.0.1",
    }),
    "  - agentic-os [bundle] — agentic-os v3.0.1",
  );
});

// --- Sequence task loading (loadTasks) --------------------------------------

/** Write a minimal task dir under `root/<id>/` and return its path. */
async function writeTaskDir(
  root: string,
  id: string,
  files: Record<string, string>,
): Promise<void> {
  const dir = path.join(root, id);
  await fs.mkdir(dir, { recursive: true });
  await Promise.all(
    Object.entries(files).map(([name, content]) =>
      fs.writeFile(path.join(dir, name), content),
    ),
  );
}

test("loadTasks: a `steps` meta builds a sequence Task with per-step prompts from files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "seqtask-"));
  try {
    await writeTaskDir(root, "seq", {
      "meta.json": JSON.stringify({
        id: "seq",
        title: "Seq",
        logicBearing: true,
        securityRelevant: false,
        steps: [
          { id: "establish", file: "step-1.md" },
          { id: "apply", file: "step-2.md", seedOverlay: "migrate/" },
        ],
      }),
      "step-1.md": "ESTABLISH the convention.",
      "step-2.md": "APPLY it now.",
      // A redundant task.md in a sequence dir must be IGNORED (steps win).
      "task.md": "POISON — should never be used.",
    });

    const tasks = await loadTasks(root);
    assert.equal(tasks.length, 1);
    const t = tasks[0]!;
    const steps = t.meta.steps!;
    assert.equal(steps.length, 2);
    assert.deepEqual(steps[0], { prompt: "ESTABLISH the convention.", id: "establish" });
    assert.deepEqual(steps[1], {
      prompt: "APPLY it now.",
      id: "apply",
      seedOverlay: "migrate/",
    });
    // Task.prompt is the FINAL step's prompt (the judge scores the final step),
    // NOT the redundant task.md.
    assert.equal(t.prompt, "APPLY it now.");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("loadTasks: a steps-less task still loads its prompt from task.md", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "single-"));
  try {
    await writeTaskDir(root, "single", {
      "meta.json": JSON.stringify({
        id: "single",
        title: "Single",
        logicBearing: false,
        securityRelevant: false,
      }),
      "task.md": "The single-shot prompt.",
    });

    const tasks = await loadTasks(root);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]!.meta.steps, undefined);
    assert.equal(tasks[0]!.prompt, "The single-shot prompt.");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// --- Shared fakes for runCell / runCampaignCell -------------------------------

const PROGRESS = () => ({ completed: 0, total: 1, started: 0, running: 0 });
const NAKED: Variant = { name: "naked", type: "claude-md", content: "" };

function makeTask(meta: Partial<TaskMeta> = {}): Task {
  return {
    meta: { id: "t", title: "T", logicBearing: false, securityRelevant: false, ...meta },
    dir: "/x",
    prompt: "final",
  };
}

function makeArtifacts(overrides: Partial<RunArtifacts> = {}): RunArtifacts {
  return {
    cellId: "c1",
    variant: "naked",
    taskId: "t",
    workspaceDir: "/w",
    diff: "",
    changedFiles: [],
    transcript: "",
    testFilesPresent: false,
    executorModel: "sonnet",
    executorMetrics: { wallMs: 0 },
    executorOk: true,
    executorTimedOut: false,
    ...overrides,
  };
}

const craft = (score: 0 | 1 | 2 | 3 | 4 | "unknown" = 2): CraftScore =>
  score === "unknown" ? { score, evidence: [] } : { score, evidence: ["a.ts:1 — x"] };

function makeVerdict(over: Partial<CellJudgeResult> = {}): CellJudgeResult {
  return {
    craft: { naming: craft(), structure: craft(), consistency: craft(), economy: craft() },
    blastRadius: [],
    correctnessAssessment: null,
    flags: [],
    ...over,
  };
}

function makeOutcome(over: Partial<JudgeCellOutcome> = {}): JudgeCellOutcome {
  return { result: makeVerdict(), evidenceTruncated: false, ...over };
}

/** runCell deps that never touch disk or containers; records which runner fired. */
function stubDeps(over: Partial<RunCellDeps> = {}): {
  deps: RunCellDeps;
  calls: { variant: number; sequence: number; judge: number };
} {
  const calls = { variant: 0, sequence: 0, judge: 0 };
  const deps: RunCellDeps = {
    runVariant: async () => {
      calls.variant++;
      return makeArtifacts();
    },
    runSequence: async () => {
      calls.sequence++;
      return makeArtifacts();
    },
    judge: async () => {
      calls.judge++;
      return makeOutcome();
    },
    writeResult: async () => {},
    ...over,
  };
  return { deps, calls };
}

// --- Cell dispatch + anchor threading (runCell) -----------------------------

test("runCell: a task WITH `steps` dispatches to runSequence, not runVariant", async () => {
  const { deps, calls } = stubDeps();
  const cell: Cell = {
    executorModel: "sonnet",
    task: makeTask({ steps: [{ prompt: "s1" }, { prompt: "s2" }] }),
    variant: NAKED,
  };
  await runCell(cell, false, PROGRESS(), "/tmp", deps);
  assert.equal(calls.variant, 0);
  assert.equal(calls.sequence, 1);
});

test("runCell: a task WITHOUT `steps` dispatches to runVariant, not runSequence", async () => {
  const { deps, calls } = stubDeps();
  const cell: Cell = { executorModel: "sonnet", task: makeTask(), variant: NAKED };
  await runCell(cell, false, PROGRESS(), "/tmp", deps);
  assert.equal(calls.variant, 1);
  assert.equal(calls.sequence, 0);
});

test("runCell: attaches the anchor verdict when meta.anchor is present", async () => {
  const anchor: AnchorResult = {
    conventionHeld: true,
    hitKnownTrap: false,
    evidence: "held integer-cents",
    grade: "held-by-literal",
  };
  let detectCalls = 0;
  const { deps } = stubDeps({
    detect: () => {
      detectCalls++;
      return anchor;
    },
  });
  const cell: Cell = {
    executorModel: "sonnet",
    task: makeTask({
      steps: [{ prompt: "s1" }, { prompt: "s2" }],
      anchor: { kind: "money-cents", correctConvention: "integer-cents", trapConvention: "decimal" },
    }),
    variant: NAKED,
  };
  const result = await runCell(cell, false, PROGRESS(), "/tmp", deps);
  assert.equal(detectCalls, 1);
  assert.deepEqual(result.anchors, anchor);
});

test("runCell: no anchor is attached (or detector called) when meta.anchor is absent", async () => {
  let detectCalls = 0;
  const { deps } = stubDeps({
    detect: () => {
      detectCalls++;
      return { conventionHeld: false, hitKnownTrap: false, evidence: "x" };
    },
  });
  const cell: Cell = { executorModel: "sonnet", task: makeTask(), variant: NAKED };
  const result = await runCell(cell, false, PROGRESS(), "/tmp", deps);
  assert.equal(detectCalls, 0);
  assert.equal(result.anchors, undefined);
});

test("runCell: executorOk gating — a failed/demoted cell gets no anchor, no judge call, and carries executorFailure", async () => {
  // runSequenceTask demotes a cell to executorOk=false when a non-final step
  // failed while leaving the final diff intact — the anchor AND judge must skip.
  let detectCalls = 0;
  const { deps, calls } = stubDeps({
    runSequence: async () =>
      makeArtifacts({
        executorOk: false,
        diff: "+const looksFine = true;",
        failureReason: "Earlier step 1 failed: executor error",
      }),
    detect: () => {
      detectCalls++;
      return { conventionHeld: true, hitKnownTrap: false, evidence: "would lie" };
    },
  });
  const cell: Cell = {
    executorModel: "sonnet",
    task: makeTask({
      steps: [{ prompt: "s1" }, { prompt: "s2" }],
      anchor: { kind: "registry", requiredFile: "src/registry.ts" },
    }),
    variant: NAKED,
  };
  const result = await runCell(cell, false, PROGRESS(), "/tmp", deps);

  assert.equal(detectCalls, 0, "anchor must not be computed for a demoted cell");
  assert.equal(calls.judge, 0, "no judge quota is spent on a failed executor");
  assert.match(result.executorFailure ?? "", /Earlier step 1 failed/);
  assert.equal(result.anchors, undefined);
  assert.equal(result.judge, undefined, "no five-axis verdict on a failed cell");
  assert.equal(result.slop, undefined, "no zero-slop masquerading as measured-clean");
});

test("runCell: threads the anchor grade, tests, slop, and out-of-scope list into the judge inputs", async () => {
  const diff = "+// TODO: fix later\n+const x = 1;";
  let seen: CellJudgePromptInputs | undefined;
  const { deps } = stubDeps({
    runVariant: async () =>
      makeArtifacts({
        diff,
        changedFiles: [
          { path: "src/a.ts", kind: "source" },
          { path: "scripts/rogue.sh", kind: "source" },
        ],
        testResults: { command: "npm test", ok: true, passed: 4, failed: 0 },
      }),
    detect: () => ({
      conventionHeld: true,
      hitKnownTrap: false,
      evidence: "held",
      grade: "held-by-literal",
    }),
    judge: async (inputs) => {
      seen = inputs;
      return makeOutcome();
    },
  });
  const cell: Cell = {
    executorModel: "sonnet",
    task: makeTask({
      anchor: { kind: "rule", required: ["x"] },
      expectedSurface: ["src/**"],
      testCommand: "npm test",
    }),
    variant: NAKED,
  };
  const result = await runCell(cell, false, PROGRESS(), "/tmp", deps);

  assert.ok(seen, "judge received inputs");
  assert.equal(seen.taskPrompt, "final");
  assert.equal(seen.conventionsList, "none", "single cells have no standing conventions");
  assert.equal(seen.anchorVerdict, "held-by-literal", "anchor grade is judge INPUT");
  assert.equal(seen.testResultsSummary, "pass (4p/0f)");
  assert.equal(seen.diff, diff);
  assert.deepEqual(seen.outOfScopeFiles, ["scripts/rogue.sh"]);
  const slop = JSON.parse(seen.slopMetricsJson) as SlopMetrics;
  assert.equal(slop.residue.todos, 1, "slop is computed from the diff");
  assert.equal(slop.churnRatio, null, "single-shot cells have no churn baseline");

  // The assembled result carries the five-axis fields.
  assert.deepEqual(result.judge, makeVerdict());
  assert.deepEqual(result.slop, slop);
  assert.deepEqual(result.testResults, { command: "npm test", ok: true, passed: 4, failed: 0 });
  assert.deepEqual(result.filesOutsideExpectedSurface, ["scripts/rogue.sh"]);
  assert.equal(result.disqualified, undefined);
});

test("runCell: no expectedSurface ⇒ filesOutsideExpectedSurface stays absent; no testCommand ⇒ summary 'none'", async () => {
  let seen: CellJudgePromptInputs | undefined;
  const { deps } = stubDeps({
    runVariant: async () =>
      makeArtifacts({ diff: "+a", changedFiles: [{ path: "src/a.ts", kind: "source" }] }),
    judge: async (inputs) => {
      seen = inputs;
      return makeOutcome();
    },
  });
  const cell: Cell = { executorModel: "sonnet", task: makeTask(), variant: NAKED };
  const result = await runCell(cell, false, PROGRESS(), "/tmp", deps);

  assert.equal(seen!.testResultsSummary, "none");
  assert.deepEqual(seen!.outOfScopeFiles, []);
  assert.equal(result.filesOutsideExpectedSurface, undefined);
  assert.equal(result.testResults, undefined);
});

// Regression guard for issue #9: the executor-ok progress line must print the
// DETERMINISTIC test verdict, never the `testFilesPresent` presence boolean —
// a `tests=true` (test file touched) once read like "tests ran/passed" and
// masked an all-empty Correctness column for a whole matrix. A revert of that
// one line must fail here.
async function captureCellLog(artifacts: RunArtifacts): Promise<string> {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => void lines.push(args.join(" "));
  try {
    const { deps } = stubDeps({ runVariant: async () => artifacts });
    const cell: Cell = { executorModel: "sonnet", task: makeTask(), variant: NAKED };
    await runCell(cell, false, PROGRESS(), "/tmp", deps);
  } finally {
    console.error = orig;
  }
  return lines.join("\n");
}

test("runCell log: executor-ok line reports the test VERDICT (`tests: none`), never `tests=<presence>` (#9)", async () => {
  const log = await captureCellLog(makeArtifacts({ testFilesPresent: true }));
  // testFilesPresent:true would print `tests=true` under the old masking bug.
  assert.match(log, /executor: ok .*tests: none/);
  assert.doesNotMatch(log, /tests=/);
});

test("runCell log: a real pass/fail verdict surfaces in the executor-ok line (#9)", async () => {
  const pass = await captureCellLog(
    makeArtifacts({ testResults: { command: "npm test", ok: true, passed: 3, failed: 0 } }),
  );
  assert.match(pass, /executor: ok .*tests: pass \(3p\/0f\)/);

  const fail = await captureCellLog(
    makeArtifacts({ testResults: { command: "npm test", ok: false, passed: 2, failed: 1 } }),
  );
  assert.match(fail, /executor: ok .*tests: fail \(2p\/1f\)/);
  assert.doesNotMatch(fail, /tests=/);
});

test("runCell: a judge failure is absorbed — fail-closed verdict, judgeFailure set, cell survives", async () => {
  const failedOutcome = makeOutcome({
    result: makeVerdict({
      craft: {
        naming: craft("unknown"),
        structure: craft("unknown"),
        consistency: craft("unknown"),
        economy: craft("unknown"),
      },
      flags: ["judge-transport-failure"],
    }),
    judgeFailure: "Judge failed after 3 attempts: container exit 1",
  });
  const { deps } = stubDeps({ judge: async () => failedOutcome });
  const cell: Cell = { executorModel: "sonnet", task: makeTask(), variant: NAKED };
  const result = await runCell(cell, false, PROGRESS(), "/tmp", deps);

  assert.match(result.judgeFailure ?? "", /Judge failed after 3 attempts/);
  assert.deepEqual(result.judge, failedOutcome.result, "the fail-closed verdict is kept");
  assert.equal(result.executorFailure, undefined);
});

test("runCell: a THROWING judge seam is absorbed, never aborts the cell", async () => {
  const { deps } = stubDeps({
    judge: async () => {
      throw new Error("judge container died");
    },
  });
  const cell: Cell = { executorModel: "sonnet", task: makeTask(), variant: NAKED };
  const result = await runCell(cell, false, PROGRESS(), "/tmp", deps);

  assert.match(result.judgeFailure ?? "", /judge container died/);
  assert.equal(result.judge?.craft.naming.score, "unknown", "fail-closed verdict attached");
  assert.deepEqual(result.judge?.flags, ["judge-threw"]);
});

test("runCell: an adversarial blast-radius entry disqualifies the cell", async () => {
  const adversarial: BlastRadiusEntry = {
    file: "test/tamper.ts",
    classification: "adversarial",
    evidence: "edited the test to pass",
  };
  const { deps } = stubDeps({
    judge: async () => makeOutcome({ result: makeVerdict({ blastRadius: [adversarial] }) }),
  });
  const cell: Cell = { executorModel: "sonnet", task: makeTask(), variant: NAKED };
  const result = await runCell(cell, false, PROGRESS(), "/tmp", deps);
  assert.equal(result.disqualified, true);

  // Non-adversarial classifications never disqualify.
  const { deps: benignDeps } = stubDeps({
    judge: async () =>
      makeOutcome({
        result: makeVerdict({
          blastRadius: [{ file: "docs/x.md", classification: "overreach", evidence: "" }],
        }),
      }),
  });
  const benign = await runCell(cell, false, PROGRESS(), "/tmp", benignDeps);
  assert.equal(benign.disqualified, undefined);
});

test("runCell: judge metrics land in metrics.judge; evidenceTruncated is carried", async () => {
  const { deps } = stubDeps({
    judge: async () =>
      makeOutcome({ metrics: { wallMs: 123, costUsd: 0.5 }, evidenceTruncated: true }),
  });
  const cell: Cell = { executorModel: "sonnet", task: makeTask(), variant: NAKED };
  const result = await runCell(cell, false, PROGRESS(), "/tmp", deps);
  assert.deepEqual(result.metrics.judge, { wallMs: 123, costUsd: 0.5 });
  assert.equal(result.evidenceTruncated, true);
});

test("runCell: threads cell.repeat into the runner and stamps result.repeat", async () => {
  const seenRepeats: (number | undefined)[] = [];
  const { deps } = stubDeps({
    runVariant: async (_v, _t, _m, _dir, _deps, repeat) => {
      seenRepeats.push(repeat);
      return makeArtifacts();
    },
  });
  const cell: Cell = { executorModel: "sonnet", task: makeTask(), variant: NAKED, repeat: 2 };
  const result = await runCell(cell, false, PROGRESS(), "/tmp", deps);
  assert.deepEqual(seenRepeats, [2], "repeat reaches the executor (→ prepareWorkspace __rN)");
  assert.equal(result.repeat, 2);

  // A repeat-less cell threads undefined and stamps nothing — byte-identical
  // single-run behavior.
  const single = await runCell(
    { executorModel: "sonnet", task: makeTask(), variant: NAKED },
    false,
    PROGRESS(),
    "/tmp",
    deps,
  );
  assert.deepEqual(seenRepeats, [2, undefined]);
  assert.equal(single.repeat, undefined);
});

test("runCell: invokes onDiff once with the cell's key, diff, and eligibility context", async () => {
  const collected: CollectedDiff[] = [];
  const { deps } = stubDeps({
    runVariant: async () => makeArtifacts({ diff: "+x" }),
    onDiff: (key, diff, context) => collected.push({ key, diff, context }),
  });
  const cell: Cell = { executorModel: "sonnet", task: makeTask(), variant: NAKED, repeat: 1 };
  await runCell(cell, false, PROGRESS(), "/tmp", deps);

  assert.equal(collected.length, 1);
  assert.deepEqual(collected[0]!.key, {
    taskId: "t",
    variant: "naked",
    executorModel: "sonnet",
    repeat: 1,
  });
  assert.equal(collected[0]!.diff, "+x");
  assert.deepEqual(collected[0]!.context, {
    anchor: "none",
    tests: "none",
    taskPrompt: "final",
    disqualified: false,
    ok: true,
  });
});

// --- setup-gotcha trace threading (runCell) ---------------------------------

const OK_ANCHOR: AnchorResult = {
  conventionHeld: true,
  hitKnownTrap: false,
  evidence: "ok",
  grade: "held-by-literal",
};

/** Capture the `finalStep` handed to `detect` so a test can assert `.trace`. */
function captureDetectDeps(): {
  deps: RunCellDeps;
  captured: { trace?: string; linkDiff?: string; called: number };
} {
  const captured: { trace?: string; linkDiff?: string; called: number } = { called: 0 };
  const { deps } = stubDeps({
    detect: (_config, finalStep, diffs) => {
      captured.called++;
      captured.trace = finalStep.trace;
      captured.linkDiff = diffs.linkDiff;
      return OK_ANCHOR;
    },
  });
  return { deps, captured };
}

/** A 2-step sequence task carrying a setup-gotcha anchor. */
function gotchaTask(): Task {
  return makeTask({
    steps: [{ prompt: "s1" }, { prompt: "s2" }],
    anchor: {
      kind: "setup-gotcha",
      setupSignal: "gen-fixtures",
      trapSignal: "Cannot find .*fixtures\\.json",
    },
  });
}

test("runCell: setup-gotcha reads the FINAL step's trace and passes it to detect", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "gotcha-trace-"));
  try {
    // artifacts.cellId is "c1"; the final step of a 2-step task tees to
    // trace-step-2.ndjson under <runResultsDir>/<cellId>/.
    const cellDir = path.join(runDir, "c1");
    await fs.mkdir(cellDir, { recursive: true });
    const trace = '{"tool":"Bash","input":"npm run gen-fixtures"}\n';
    await fs.writeFile(path.join(cellDir, "trace-step-2.ndjson"), trace);

    const { deps, captured } = captureDetectDeps();
    const cell: Cell = { executorModel: "sonnet", task: gotchaTask(), variant: NAKED };
    const result = await runCell(cell, false, PROGRESS(), runDir, deps);

    assert.equal(captured.called, 1);
    assert.equal(captured.trace, trace);
    assert.deepEqual(result.anchors, OK_ANCHOR);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("runCell: setup-gotcha with a MISSING trace does not throw; trace is undefined", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "gotcha-notrace-"));
  try {
    // No trace file on disk — the read must resolve undefined, not throw.
    const { deps, captured } = captureDetectDeps();
    const cell: Cell = { executorModel: "sonnet", task: gotchaTask(), variant: NAKED };
    const result = await runCell(cell, false, PROGRESS(), runDir, deps);

    assert.equal(captured.called, 1);
    assert.equal(captured.trace, undefined);
    assert.deepEqual(result.anchors, OK_ANCHOR);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("runCell: a diff-based anchor (registry) does NOT read a trace even when one exists", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "registry-notrace-"));
  try {
    // A trace file exists on disk, but a registry anchor is diff-based and must
    // never read it — the finalStep handed to detect has trace undefined. The
    // graded detector also receives the final diff as the linkDiff scope.
    const cellDir = path.join(runDir, "c1");
    await fs.mkdir(cellDir, { recursive: true });
    await fs.writeFile(path.join(cellDir, "trace-step-2.ndjson"), "SHOULD NOT BE READ");

    const { deps, captured } = captureDetectDeps();
    const cell: Cell = {
      executorModel: "sonnet",
      task: makeTask({
        steps: [{ prompt: "s1" }, { prompt: "s2" }],
        anchor: { kind: "registry", requiredFile: "src/registry.ts" },
      }),
      variant: NAKED,
    };
    const result = await runCell(cell, false, PROGRESS(), runDir, deps);

    assert.equal(captured.called, 1);
    assert.equal(captured.trace, undefined);
    assert.equal(captured.linkDiff, "", "the final diff is the graded linkDiff scope");
    assert.deepEqual(result.anchors, OK_ANCHOR);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

// --- Campaign loading (loadTasks) -------------------------------------------

test("loadTasks: a `campaign` meta builds a Task with per-link prompts + anchors", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "camptask-"));
  try {
    const anchor: AnchorConfig = {
      kind: "rule",
      label: "R2 newId",
      required: ["newId\\("],
      forbidden: ["\\brandomUUID\\b"],
    };
    await writeTaskDir(root, "camp", {
      "meta.json": JSON.stringify({
        id: "camp",
        title: "Camp",
        logicBearing: true,
        securityRelevant: false,
        campaign: [
          { id: "t1-search", file: "t1.md" },
          { id: "t2-rename", file: "t2.md", anchor },
        ],
      }),
      "t1.md": "FIRST link ask.",
      "t2.md": "SECOND link ask.",
      // A redundant task.md in a campaign dir must be IGNORED (campaign wins).
      "task.md": "POISON — should never be used.",
    });

    const tasks = await loadTasks(root);
    assert.equal(tasks.length, 1);
    const t = tasks[0]!;
    const campaign = t.meta.campaign!;
    assert.equal(campaign.length, 2);
    // Per-link prompts resolved from files; id carried; no anchor on link 0.
    assert.deepEqual(campaign[0], { prompt: "FIRST link ask.", id: "t1-search" });
    // Link 1 carries id AND the anchor, verbatim.
    assert.deepEqual(campaign[1], { prompt: "SECOND link ask.", id: "t2-rename", anchor });
    // Task.prompt is the FIRST link's prompt (any valid), NOT the redundant task.md.
    assert.equal(t.prompt, "FIRST link ask.");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("loadTasks: a campaign `file` escaping the task dir is rejected", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "campescape-"));
  try {
    await writeTaskDir(root, "camp", {
      "meta.json": JSON.stringify({
        id: "camp",
        title: "Camp",
        logicBearing: true,
        securityRelevant: false,
        campaign: [{ id: "evil", file: "../../etc/passwd" }],
      }),
    });
    await assert.rejects(loadTasks(root), /escapes its base directory/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// --- Campaign dispatch + per-link judge/anchor (runCampaignCell) -------------

/** A campaign task carrying resolved per-link prompts + anchors (as loadTasks builds). */
function campaignTask(): Task {
  return makeTask({
    id: "camp",
    campaign: [
      { prompt: "ask 0", id: "t0" },
      {
        prompt: "ask 1",
        id: "t1",
        anchor: { kind: "rule", label: "R", required: ["newId\\("] },
      },
    ],
  });
}

/** Build one link's artifacts, executorOk unless overridden. */
function makeLink(index: number, over: Partial<RunArtifacts> = {}): CampaignTaskArtifacts {
  return {
    campaignTaskId: `t${index}`,
    index,
    artifacts: makeArtifacts({ diff: `diff-${index}`, ...over }),
  };
}

test("runCampaignCell: routes to runCampaign and assembles a CampaignResult per link", async () => {
  const judged: string[] = [];
  const detected: AnchorConfig[] = [];
  let campaignCalls = 0;
  const deps: RunCampaignDeps = {
    campaign: async () => {
      campaignCalls++;
      return [makeLink(0), makeLink(1)];
    },
    // The judge sees each link's OWN ask — proves the per-link prompt threading.
    judge: async (inputs) => {
      judged.push(inputs.taskPrompt);
      return makeOutcome();
    },
    detect: (config) => {
      detected.push(config);
      return {
        conventionHeld: true,
        hitKnownTrap: false,
        evidence: "held",
        grade: "held-by-literal",
      };
    },
  };

  const cell: Cell = { executorModel: "sonnet", task: campaignTask(), variant: NAKED };
  const result = await runCampaignCell(cell, "/tmp", deps);

  // One chain run; each link judged against its own prompt, in order.
  assert.equal(campaignCalls, 1);
  assert.deepEqual(judged, ["ask 0", "ask 1"]);
  // Only link 1 declares an anchor, so detect fires exactly once.
  assert.equal(detected.length, 1);
  assert.equal(detected[0]!.kind, "rule");

  assert.equal(result.variant, "naked");
  assert.equal(result.executorModel, "sonnet");
  assert.equal(result.campaignId, "camp");
  assert.equal(result.tasks.length, 2);

  // Link 0: judged (five-axis verdict + slop), no anchor.
  const link0 = result.tasks[0]!;
  assert.equal(link0.taskId, "t0");
  assert.equal(link0.index, 0);
  assert.deepEqual(link0.judge, makeVerdict());
  assert.ok(link0.slop, "slop metrics attached per link");
  assert.equal(link0.anchors, undefined);
  assert.equal(link0.failure, undefined);

  // Link 1: judged AND anchored (graded).
  const link1 = result.tasks[1]!;
  assert.equal(link1.taskId, "t1");
  assert.equal(link1.anchors?.grade, "held-by-literal");
});

test("runCampaignCell: rule anchor grades held-by-abstraction via the CUMULATIVE diff (false-negative fix)", async () => {
  // campaignTask()'s link 1 anchor requires /newId\(/. Simulate a link that REUSED
  // a `makeId()` wrapper an earlier link defined AROUND the newId( marker: the
  // per-link diff never re-emits the marker, but the cumulative chain diff
  // (base → this link) contains it, and the wrapper's name (`makeId`, harvested
  // from the marker's ±3-line window) reappearing in the link diff is the
  // LINKAGE EVIDENCE the held-by-abstraction grade now requires (fd9239c
  // semantics: helper reuse still counts as held).
  const perLinkDiffWithoutMarker = "+  const attachment = { id: makeId() };";
  const cumulativeWithMarker =
    "+function makeId() { return newId(); }\n+  const doc = { id: makeId() };";

  // WITH the cumulative diff wired in: the real graded detector finds /newId\(/
  // in the chain's work, ties it to this link via the reused `makeId` identifier,
  // and grades a held-by-abstraction (conventionHeld true).
  const held = await runCampaignCell(
    { executorModel: "sonnet", task: campaignTask(), variant: NAKED },
    "/tmp",
    {
      campaign: async () => [
        makeLink(0),
        {
          campaignTaskId: "t1",
          index: 1,
          artifacts: makeArtifacts({ diff: perLinkDiffWithoutMarker }),
          cumulativeDiff: cumulativeWithMarker,
        },
      ],
      judge: async () => makeOutcome(),
      detect: detectAnchorGraded, // the REAL deterministic detector, not a stub
    },
  );
  assert.equal(
    held.tasks[1]!.anchors?.conventionHeld,
    true,
    "convention should hold: required marker is in the cumulative diff",
  );
  assert.equal(held.tasks[1]!.anchors?.grade, "held-by-abstraction");

  // WITHOUT a cumulative diff (same per-link diff), only the link diff is in
  // scope — the marker is absent and real added code exists, so the SAME anchor
  // grades drift. This is exactly the false negative the cumulative wiring fixes.
  const broken = await runCampaignCell(
    { executorModel: "sonnet", task: campaignTask(), variant: NAKED },
    "/tmp",
    {
      campaign: async () => [
        makeLink(0),
        {
          campaignTaskId: "t1",
          index: 1,
          artifacts: makeArtifacts({ diff: perLinkDiffWithoutMarker }),
          // no cumulativeDiff
        },
      ],
      judge: async () => makeOutcome(),
      detect: detectAnchorGraded,
    },
  );
  assert.equal(
    broken.tasks[1]!.anchors?.conventionHeld,
    false,
    "control: with only the per-link diff, the same anchor breaks",
  );
  assert.equal(broken.tasks[1]!.anchors?.grade, "drift");
});

test("runCampaignCell: a link lacking an anchor skips anchoring for that link", async () => {
  let detectCalls = 0;
  const deps: RunCampaignDeps = {
    campaign: async () => [makeLink(0), makeLink(1)],
    judge: async () => makeOutcome(),
    detect: () => {
      detectCalls++;
      return { conventionHeld: false, hitKnownTrap: false, evidence: "x" };
    },
  };
  const cell: Cell = { executorModel: "sonnet", task: campaignTask(), variant: NAKED };
  const result = await runCampaignCell(cell, "/tmp", deps);

  // Only link 1 has an anchor; link 0 must skip the detector entirely.
  assert.equal(detectCalls, 1);
  assert.equal(result.tasks[0]!.anchors, undefined);
  assert.ok(result.tasks[1]!.anchors, "link 1 carries an anchor verdict");
});

test("runCampaignCell: a failed executor link gets no anchor, no judge call, and carries a failure", async () => {
  let detectCalls = 0;
  const judgedPrompts: string[] = [];
  const deps: RunCampaignDeps = {
    campaign: async () => [
      // Link 1 (which DOES declare an anchor) failed its executor.
      makeLink(0),
      makeLink(1, { executorOk: false, failureReason: "executor blew up" }),
    ],
    judge: async (inputs) => {
      judgedPrompts.push(inputs.taskPrompt);
      return makeOutcome();
    },
    detect: () => {
      detectCalls++;
      return { conventionHeld: true, hitKnownTrap: false, evidence: "held" };
    },
  };
  const cell: Cell = { executorModel: "sonnet", task: campaignTask(), variant: NAKED };
  const result = await runCampaignCell(cell, "/tmp", deps);

  // Anchor gated on executorOk: the failed link is NOT anchored despite declaring one.
  assert.equal(detectCalls, 0);
  // The judge only ever saw the healthy link — no quota spent on the failed one.
  assert.deepEqual(judgedPrompts, ["ask 0"]);
  assert.equal(result.tasks[0]!.failure, undefined);
  assert.ok(result.tasks[0]!.judge, "healthy link carries a verdict");
  assert.equal(result.tasks[1]!.failure, "executor blew up");
  assert.equal(result.tasks[1]!.anchors, undefined);
  assert.equal(result.tasks[1]!.judge, undefined);
});

test("runCampaignCell: a judge failure on one link is captured, chain continues, anchor survives", async () => {
  const deps: RunCampaignDeps = {
    campaign: async () => [makeLink(0), makeLink(1)],
    // Link 0's judge fail-closes; link 1 succeeds. Neither aborts the chain.
    judge: async (inputs) =>
      inputs.taskPrompt === "ask 0"
        ? makeOutcome({ judgeFailure: "judge container died" })
        : makeOutcome(),
    detect: () => ({
      conventionHeld: false,
      hitKnownTrap: false,
      evidence: "broken",
      grade: "drift",
    }),
  };
  const cell: Cell = { executorModel: "sonnet", task: campaignTask(), variant: NAKED };
  const result = await runCampaignCell(cell, "/tmp", deps);

  assert.equal(result.tasks.length, 2);
  // Link 0: judge failed → failure recorded, no fabricated verdictless score.
  assert.match(result.tasks[0]!.failure ?? "", /judge container died/);
  // Link 1: still judged — one bad link did not abort the campaign. Its anchor
  // verdict (independent of the judge) is present.
  assert.equal(result.tasks[1]!.failure, undefined);
  assert.deepEqual(result.tasks[1]!.judge, makeVerdict());
  assert.equal(result.tasks[1]!.anchors?.grade, "drift");
});

test("runCampaignCell: a THROWING judge seam on one link is absorbed, chain continues", async () => {
  const deps: RunCampaignDeps = {
    campaign: async () => [makeLink(0), makeLink(1)],
    judge: async (inputs) => {
      if (inputs.taskPrompt === "ask 0") throw new Error("judge exploded");
      return makeOutcome();
    },
    detect: () => ({ conventionHeld: true, hitKnownTrap: false, evidence: "held" }),
  };
  const cell: Cell = { executorModel: "sonnet", task: campaignTask(), variant: NAKED };
  const result = await runCampaignCell(cell, "/tmp", deps);

  assert.match(result.tasks[0]!.failure ?? "", /judge exploded/);
  assert.equal(result.tasks[1]!.failure, undefined);
});

test("runCampaignCell: conventionsList accumulates rule-anchor labels up to the current link", async () => {
  const seen: string[] = [];
  const task = makeTask({
    id: "camp",
    campaign: [
      { prompt: "ask 0", id: "t0", anchor: { kind: "rule", label: "R1 epoch-seconds", required: ["x"] } },
      { prompt: "ask 1", id: "t1" },
      { prompt: "ask 2", id: "t2", anchor: { kind: "rule", label: "R2 ulid_ format", required: ["y"] } },
    ],
  });
  const deps: RunCampaignDeps = {
    campaign: async () => [makeLink(0), makeLink(1), makeLink(2)],
    judge: async (inputs) => {
      seen.push(inputs.conventionsList);
      return makeOutcome();
    },
    detect: () => ({ conventionHeld: true, hitKnownTrap: false, evidence: "held" }),
  };
  await runCampaignCell({ executorModel: "sonnet", task, variant: NAKED }, "/tmp", deps);

  assert.deepEqual(seen, [
    "- R1 epoch-seconds",
    "- R1 epoch-seconds",
    "- R1 epoch-seconds\n- R2 ulid_ format",
  ]);
});

test("runCampaignCell: conventionsList is 'none' when no rule anchor is declared yet", async () => {
  const seen: string[] = [];
  const deps: RunCampaignDeps = {
    campaign: async () => [makeLink(0)],
    judge: async (inputs) => {
      seen.push(inputs.conventionsList);
      return makeOutcome();
    },
  };
  // campaignTask link 0 has no anchor, so its judge sees no standing conventions.
  const task = makeTask({ id: "camp", campaign: [{ prompt: "ask 0", id: "t0" }] });
  await runCampaignCell({ executorModel: "sonnet", task, variant: NAKED }, "/tmp", deps);
  assert.deepEqual(seen, ["none"]);
});

test("runCampaignCell: earlierAddedLines accumulate in order, AFTER each link's own slop, ok links only", async () => {
  const slops: SlopMetrics[] = [];
  const task = makeTask({
    id: "camp",
    campaign: [
      { prompt: "ask 0", id: "t0" },
      { prompt: "ask 1", id: "t1" },
      { prompt: "ask 2", id: "t2" },
    ],
  });
  const deps: RunCampaignDeps = {
    campaign: async () => [
      // Link 0 establishes a line; link 1 FAILS (its diff must NOT enter the
      // baseline); link 2 deletes only link 1's line — churn must be 0.
      makeLink(0, { diff: "+alpha();" }),
      makeLink(1, { diff: "+beta();", executorOk: false, failureReason: "boom" }),
      makeLink(2, { diff: "-beta();\n+gamma();" }),
    ],
    judge: async (inputs) => {
      slops.push(JSON.parse(inputs.slopMetricsJson) as SlopMetrics);
      return makeOutcome();
    },
  };
  await runCampaignCell({ executorModel: "sonnet", task, variant: NAKED }, "/tmp", deps);

  // Judge ran for links 0 and 2 only (link 1's executor failed).
  assert.equal(slops.length, 2);
  // Link 0: no earlier work yet — churn is unmeasurable, never a fake clean 0.
  assert.equal(slops[0]!.churnRatio, null, "first link has no churn baseline");
  // Link 2: baseline is ONLY link 0's alpha(); (the failed link contributed
  // nothing), and deleting beta(); matches none of it — churn 0. If the failed
  // link's lines had leaked into the baseline this would read 0.5.
  assert.equal(slops[1]!.churnRatio, 0, "failed links never enter the churn baseline");
});

test("runCampaignCell: a link deleting an earlier link's added line registers churn", async () => {
  const slops: SlopMetrics[] = [];
  const task = makeTask({
    id: "camp",
    campaign: [
      { prompt: "ask 0", id: "t0" },
      { prompt: "ask 1", id: "t1" },
    ],
  });
  const deps: RunCampaignDeps = {
    campaign: async () => [
      makeLink(0, { diff: "+alpha();" }),
      // Link 1 rewrites link 0's work: deletes alpha, adds beta. Slop for link 1
      // runs BEFORE its own lines join the baseline (it can't churn against itself).
      makeLink(1, { diff: "-alpha();\n+beta();" }),
    ],
    judge: async (inputs) => {
      slops.push(JSON.parse(inputs.slopMetricsJson) as SlopMetrics);
      return makeOutcome();
    },
  };
  await runCampaignCell({ executorModel: "sonnet", task, variant: NAKED }, "/tmp", deps);

  assert.equal(slops[0]!.churnRatio, null);
  assert.equal(slops[1]!.churnRatio, 1, "link 1 deleted 1/1 of the chain's earlier lines");
});

test("runCampaignCell: threads repeat to the chain runner and stamps CampaignResult.repeat", async () => {
  const seenRepeats: (number | undefined)[] = [];
  const deps: RunCampaignDeps = {
    campaign: async (_v, _t, _m, _dir, _deps, repeat) => {
      seenRepeats.push(repeat);
      return [makeLink(0)];
    },
    judge: async () => makeOutcome(),
  };
  const task = makeTask({ id: "camp", campaign: [{ prompt: "ask 0", id: "t0" }] });

  const repeated = await runCampaignCell(
    { executorModel: "sonnet", task, variant: NAKED, repeat: 2 },
    "/tmp",
    deps,
  );
  assert.equal(repeated.repeat, 2);

  const single = await runCampaignCell(
    { executorModel: "sonnet", task, variant: NAKED },
    "/tmp",
    deps,
  );
  assert.equal(single.repeat, undefined);
  assert.deepEqual(seenRepeats, [2, undefined]);
});

test("runCampaignCell: invokes onDiff per link with linkIndex and the link's own context", async () => {
  const collected: CollectedDiff[] = [];
  const deps: RunCampaignDeps = {
    campaign: async () => [
      makeLink(0, { diff: "+a" }),
      makeLink(1, { diff: "", executorOk: false, failureReason: "boom" }),
    ],
    judge: async () => makeOutcome(),
    detect: () => ({ conventionHeld: true, hitKnownTrap: false, evidence: "held", grade: "held-by-literal" }),
    onDiff: (key, diff, context) => collected.push({ key, diff, context }),
  };
  const cell: Cell = { executorModel: "sonnet", task: campaignTask(), variant: NAKED };
  await runCampaignCell(cell, "/tmp", deps);

  assert.equal(collected.length, 2);
  assert.deepEqual(collected[0]!.key, {
    taskId: "camp",
    variant: "naked",
    executorModel: "sonnet",
    linkIndex: 0,
  });
  assert.equal(collected[0]!.context.taskPrompt, "ask 0");
  assert.equal(collected[0]!.context.ok, true);
  // The failed link is still reported — with ok:false, so buildPairJobs drops it.
  assert.equal(collected[1]!.key.linkIndex, 1);
  assert.equal(collected[1]!.context.ok, false);
});

// --- Repeats fan-out (buildCells) ---------------------------------------------

test("buildCells: repeats=1 emits one repeat-less cell per (model × task × variant)", () => {
  const single = makeTask({ id: "a" });
  const camp = makeTask({ id: "c", campaign: [{ prompt: "p", id: "t0" }] });
  const { cells, campaignCells } = buildCells(["sonnet"], [single, camp], [NAKED], 1);

  assert.equal(cells.length, 1);
  assert.equal(campaignCells.length, 1);
  assert.equal(cells[0]!.repeat, undefined, "single runs carry NO repeat (byte-identical ids)");
  assert.equal(campaignCells[0]!.repeat, undefined);
});

test("buildCells: repeats=2 fans out BOTH lanes with repeat stamped 1..N", () => {
  const single = makeTask({ id: "a" });
  const camp = makeTask({ id: "c", campaign: [{ prompt: "p", id: "t0" }] });
  const other: Variant = { name: "os", type: "claude-md", content: "" };
  const { cells, campaignCells } = buildCells(["sonnet"], [single, camp], [NAKED, other], 2);

  // 1 model × 1 single task × 2 variants × 2 repeats.
  assert.equal(cells.length, 4);
  assert.deepEqual(
    cells.map((c) => [c.variant.name, c.repeat]),
    [
      ["naked", 1],
      ["naked", 2],
      ["os", 1],
      ["os", 2],
    ],
  );
  // The campaign lane fans out identically.
  assert.equal(campaignCells.length, 4);
  assert.deepEqual(
    campaignCells.map((c) => c.repeat),
    [1, 2, 1, 2],
  );
});

// --- Stable result ordering ------------------------------------------------------

test("resultSortComparator: model order → variant order → taskId → repeat", () => {
  const r = (
    executorModel: string,
    variant: string,
    taskId: string,
    repeat?: number,
  ): VariantTaskResult =>
    ({ executorModel, variant, taskId, ...(repeat !== undefined ? { repeat } : {}) }) as VariantTaskResult;

  const results = [
    r("opus", "naked", "a"),
    r("sonnet", "os", "a"),
    r("sonnet", "naked", "b", 2),
    r("sonnet", "naked", "b", 1),
    r("sonnet", "naked", "a"),
  ];
  results.sort(resultSortComparator(["sonnet", "opus"], ["naked", "os"]));

  assert.deepEqual(
    results.map((x) => `${x.executorModel} ${x.variant} ${x.taskId} r${x.repeat ?? 0}`),
    [
      "sonnet naked a r0",
      "sonnet naked b r1",
      "sonnet naked b r2",
      "sonnet os a r0",
      "opus naked a r0",
    ],
  );
});

// --- Pairwise lane (buildPairJobs) --------------------------------------------

function rec(
  key: Partial<CellDiffKey> & { variant: string },
  diff = "+x",
  context: Partial<CellDiffContext> = {},
): CollectedDiff {
  return {
    key: { taskId: "t", executorModel: "sonnet", ...key },
    diff,
    context: {
      anchor: "none",
      tests: "none",
      taskPrompt: "final",
      disqualified: false,
      ok: true,
      ...context,
    },
  };
}

test("buildPairJobs: two ok variants on the same cell → exactly one job in canonical order", () => {
  const jobs = buildPairJobs([
    rec({ variant: "naked" }, "+a", { anchor: "drift", tests: "pass" }),
    rec({ variant: "os" }, "+b", { anchor: "held-by-literal", tests: "fail" }),
  ]);

  assert.equal(jobs.length, 1);
  const job = jobs[0]!;
  assert.equal(job.taskId, "t");
  assert.equal(job.executorModel, "sonnet");
  assert.equal(job.linkIndex, undefined);
  assert.equal(job.repeat, undefined);
  assert.equal(job.taskPrompt, "final");
  // Canonical (first-seen) order — judgePair randomizes A/B itself.
  assert.deepEqual(job.first, { variant: "naked", diff: "+a", anchor: "drift", tests: "pass" });
  assert.deepEqual(job.second, {
    variant: "os",
    diff: "+b",
    anchor: "held-by-literal",
    tests: "fail",
  });
});

test("buildPairJobs: failed, disqualified, and empty-diff cells are ineligible", () => {
  assert.deepEqual(
    buildPairJobs([
      rec({ variant: "naked" }, "+a", { ok: false }),
      rec({ variant: "os" }, "+b"),
    ]),
    [],
    "a failed side never pairs",
  );
  assert.deepEqual(
    buildPairJobs([
      rec({ variant: "naked" }, "+a", { disqualified: true }),
      rec({ variant: "os" }, "+b"),
    ]),
    [],
    "a disqualified side never pairs",
  );
  assert.deepEqual(
    buildPairJobs([rec({ variant: "naked" }, ""), rec({ variant: "os" }, "+b")]),
    [],
    "an empty diff never pairs",
  );
});

test("buildPairJobs: grouping never crosses task, model, repeat, or campaign link", () => {
  const jobs = buildPairJobs([
    // Different tasks.
    rec({ variant: "naked", taskId: "t1" }),
    rec({ variant: "os", taskId: "t2" }),
    // Different models.
    rec({ variant: "naked", taskId: "t3" }),
    rec({ variant: "os", taskId: "t3", executorModel: "opus" }),
    // Different repeats.
    rec({ variant: "naked", taskId: "t4", repeat: 1 }),
    rec({ variant: "os", taskId: "t4", repeat: 2 }),
    // Different campaign links (and link vs no-link).
    rec({ variant: "naked", taskId: "camp", linkIndex: 0 }),
    rec({ variant: "os", taskId: "camp", linkIndex: 1 }),
    rec({ variant: "gstack", taskId: "camp" }),
  ]);
  assert.deepEqual(jobs, []);
});

test("buildPairJobs: a 3-variant group yields all 3 unordered pairs; key fields carried", () => {
  const jobs = buildPairJobs([
    rec({ variant: "a", taskId: "camp", linkIndex: 2, repeat: 1 }),
    rec({ variant: "b", taskId: "camp", linkIndex: 2, repeat: 1 }),
    rec({ variant: "c", taskId: "camp", linkIndex: 2, repeat: 1 }),
  ]);
  assert.deepEqual(
    jobs.map((j) => [j.first.variant, j.second.variant]),
    [
      ["a", "b"],
      ["a", "c"],
      ["b", "c"],
    ],
  );
  for (const j of jobs) {
    assert.equal(j.taskId, "camp");
    assert.equal(j.linkIndex, 2);
    assert.equal(j.repeat, 1);
  }
});
