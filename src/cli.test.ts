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
  runCell,
  type RunCellDeps,
} from "./cli.js";
import type {
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
  assert.match(b.description ?? "", /agentic-os v2\.6\.0/);
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
      description: "agentic-os v2.6.0",
    }),
    "  - agentic-os [bundle] — agentic-os v2.6.0",
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
