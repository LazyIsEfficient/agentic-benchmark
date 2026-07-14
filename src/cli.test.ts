import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  MAX_CONCURRENCY,
  formatVariantListLine,
  loadTasks,
  loadVariants,
  parseConcurrency,
  parseDelayMs,
  parseModels,
  runCampaignCell,
  runCell,
  type RunCampaignDeps,
  type RunCellDeps,
} from "./cli.js";
import type { CampaignTaskArtifacts } from "./executor.js";
import type {
  AnchorConfig,
  AnchorResult,
  CopyBundleVariant,
  JudgeResult,
  RunArtifacts,
  SetupBundleVariant,
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

// --- Cell dispatch + anchor threading (runCell) -----------------------------

type CellArg = Parameters<typeof runCell>[0];
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

const ZERO_DIM = { score: 0, justification: "" };
function makeResult(overrides: Partial<VariantTaskResult> = {}): VariantTaskResult {
  const raw: JudgeResult = {
    codeQuality: ZERO_DIM,
    testingCoverage: ZERO_DIM,
    securityQuality: ZERO_DIM,
    documentation: ZERO_DIM,
    securityReviewPerformed: true,
    summary: "",
  };
  return {
    cellId: "c1",
    variant: "naked",
    taskId: "t",
    executorModel: "sonnet",
    judgeModel: "opus",
    raw,
    final: { codeQuality: 0, testingCoverage: 0, securityQuality: 0, documentation: 0 },
    total: 42,
    appliedCaps: [],
    signals: { testFilesPresent: false, securityReviewPerformed: true, changedFiles: [] },
    metrics: { executor: { wallMs: 0 } },
    ...overrides,
  };
}

/** runCell deps that never touch disk or containers; records which runner fired. */
function stubDeps(over: Partial<RunCellDeps> = {}): {
  deps: RunCellDeps;
  calls: { variant: number; sequence: number };
} {
  const calls = { variant: 0, sequence: 0 };
  const deps: RunCellDeps = {
    runVariant: async () => {
      calls.variant++;
      return makeArtifacts();
    },
    runSequence: async () => {
      calls.sequence++;
      return makeArtifacts();
    },
    judge: async () => makeResult(),
    writeResult: async () => {},
    ...over,
  };
  return { deps, calls };
}

test("runCell: a task WITH `steps` dispatches to runSequence, not runVariant", async () => {
  const { deps, calls } = stubDeps();
  const cell: CellArg = {
    executorModel: "sonnet",
    task: makeTask({ steps: [{ prompt: "s1" }, { prompt: "s2" }] }),
    variant: NAKED,
  };
  await runCell(cell, false, PROGRESS(), "/tmp", deps);
  assert.deepEqual(calls, { variant: 0, sequence: 1 });
});

test("runCell: a task WITHOUT `steps` dispatches to runVariant, not runSequence", async () => {
  const { deps, calls } = stubDeps();
  const cell: CellArg = { executorModel: "sonnet", task: makeTask(), variant: NAKED };
  await runCell(cell, false, PROGRESS(), "/tmp", deps);
  assert.deepEqual(calls, { variant: 1, sequence: 0 });
});

test("runCell: attaches the anchor verdict when meta.anchor is present", async () => {
  const anchor: AnchorResult = {
    conventionHeld: true,
    hitKnownTrap: false,
    evidence: "held integer-cents",
  };
  let detectCalls = 0;
  const { deps } = stubDeps({
    detect: () => {
      detectCalls++;
      return anchor;
    },
  });
  const cell: CellArg = {
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
  const cell: CellArg = { executorModel: "sonnet", task: makeTask(), variant: NAKED };
  const result = await runCell(cell, false, PROGRESS(), "/tmp", deps);
  assert.equal(detectCalls, 0);
  assert.equal(result.anchors, undefined);
});

// --- setup-gotcha trace threading (runCell) ---------------------------------

const OK_ANCHOR: AnchorResult = { conventionHeld: true, hitKnownTrap: false, evidence: "ok" };

/** Capture the `finalStep` handed to `detect` so a test can assert `.trace`. */
function captureDetectDeps(): {
  deps: RunCellDeps;
  captured: { trace?: string; called: number };
} {
  const captured: { trace?: string; called: number } = { called: 0 };
  const { deps } = stubDeps({
    detect: (_config, finalStep) => {
      captured.called++;
      captured.trace = finalStep.trace;
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
    const cell: CellArg = { executorModel: "sonnet", task: gotchaTask(), variant: NAKED };
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
    const cell: CellArg = { executorModel: "sonnet", task: gotchaTask(), variant: NAKED };
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
    // never read it — the finalStep handed to detect has trace undefined.
    const cellDir = path.join(runDir, "c1");
    await fs.mkdir(cellDir, { recursive: true });
    await fs.writeFile(path.join(cellDir, "trace-step-2.ndjson"), "SHOULD NOT BE READ");

    const { deps, captured } = captureDetectDeps();
    const cell: CellArg = {
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
    // Score each link against ITS OWN prompt — proves the judge sees the link ask.
    judge: async (_artifacts, t) => {
      judged.push(t.prompt);
      return makeResult({ total: t.prompt === "ask 0" ? 10 : 90 });
    },
    detect: (config) => {
      detected.push(config);
      return { conventionHeld: true, hitKnownTrap: false, evidence: "held" };
    },
  };

  const cell = { executorModel: "sonnet", task: campaignTask(), variant: NAKED };
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
  // Link 0: scored, no anchor (no anchor declared).
  assert.deepEqual(result.tasks[0], {
    taskId: "t0",
    index: 0,
    metrics: { wallMs: 0 },
    score: 10,
  });
  // Link 1: scored AND anchored.
  assert.deepEqual(result.tasks[1], {
    taskId: "t1",
    index: 1,
    metrics: { wallMs: 0 },
    score: 90,
    anchors: { conventionHeld: true, hitKnownTrap: false, evidence: "held" },
  });
});

test("runCampaignCell: a link lacking an anchor skips anchoring for that link", async () => {
  let detectCalls = 0;
  const deps: RunCampaignDeps = {
    campaign: async () => [makeLink(0), makeLink(1)],
    judge: async () => makeResult({ total: 50 }),
    detect: () => {
      detectCalls++;
      return { conventionHeld: false, hitKnownTrap: false, evidence: "x" };
    },
  };
  const cell = { executorModel: "sonnet", task: campaignTask(), variant: NAKED };
  const result = await runCampaignCell(cell, "/tmp", deps);

  // Only link 1 has an anchor; link 0 must skip the detector entirely.
  assert.equal(detectCalls, 1);
  assert.equal(result.tasks[0]!.anchors, undefined);
  assert.ok(result.tasks[1]!.anchors, "link 1 carries an anchor verdict");
});

test("runCampaignCell: a failed executor link gets no anchor and carries a failure", async () => {
  let detectCalls = 0;
  const deps: RunCampaignDeps = {
    campaign: async () => [
      // Link 1 (which DOES declare an anchor) failed its executor.
      makeLink(0),
      makeLink(1, { executorOk: false, failureReason: "executor blew up" }),
    ],
    // judgeRun returns a failure result (executorFailure set) for a failed executor;
    // emulate that here so the assemble path sees executorFailure.
    judge: async (artifacts) =>
      artifacts.executorOk
        ? makeResult({ total: 70 })
        : makeResult({ total: 0, executorFailure: artifacts.failureReason }),
    detect: () => {
      detectCalls++;
      return { conventionHeld: true, hitKnownTrap: false, evidence: "held" };
    },
  };
  const cell = { executorModel: "sonnet", task: campaignTask(), variant: NAKED };
  const result = await runCampaignCell(cell, "/tmp", deps);

  // Anchor gated on executorOk: the failed link is NOT anchored despite declaring one.
  assert.equal(detectCalls, 0);
  assert.deepEqual(result.tasks[0], { taskId: "t0", index: 0, metrics: { wallMs: 0 }, score: 70 });
  assert.equal(result.tasks[1]!.score, undefined);
  assert.equal(result.tasks[1]!.failure, "executor blew up");
  assert.equal(result.tasks[1]!.anchors, undefined);
});

test("runCampaignCell: a judge failure on one link is captured, chain continues", async () => {
  const deps: RunCampaignDeps = {
    campaign: async () => [makeLink(0), makeLink(1)],
    // Link 0's judge throws; link 1 succeeds. The throw must not abort the chain.
    judge: async (_artifacts, t) => {
      if (t.prompt === "ask 0") throw new Error("judge container died");
      return makeResult({ total: 88 });
    },
    detect: () => ({ conventionHeld: false, hitKnownTrap: false, evidence: "broken" }),
  };
  const cell = { executorModel: "sonnet", task: campaignTask(), variant: NAKED };
  const result = await runCampaignCell(cell, "/tmp", deps);

  assert.equal(result.tasks.length, 2);
  // Link 0: judge failed → no score, failure recorded.
  assert.equal(result.tasks[0]!.score, undefined);
  assert.match(result.tasks[0]!.failure ?? "", /judge container died/);
  // Link 1: still scored — one bad link did not abort the campaign.
  assert.equal(result.tasks[1]!.score, 88);
});
