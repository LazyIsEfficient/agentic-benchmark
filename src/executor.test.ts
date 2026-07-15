import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  needsSetupPreStep,
  runCampaign,
  runSequenceTask,
  runSetupPreStep,
  runVariantTask,
  runWithExecutorRetry,
} from "./executor.js";
import type { ExecutorRunner, TestRunner } from "./executor.js";
import { git, prepareWorkspace } from "./workspace.js";
import type { ContainerResult } from "./docker.js";
import type { RunArtifacts, Task, Variant } from "./types.js";

/** Minimal RunArtifacts for the retry-decision tests. */
function artifacts(over: Partial<RunArtifacts>): RunArtifacts {
  return {
    cellId: "t__v__sonnet",
    variant: "v",
    taskId: "t",
    workspaceDir: "/tmp/ws",
    diff: "",
    changedFiles: [],
    transcript: "",
    testFilesPresent: false,
    executorModel: "sonnet",
    executorMetrics: { wallMs: 1 },
    executorOk: false,
    executorTimedOut: false,
    ...over,
  };
}

const noSleep = async () => {};

test("a timed-out executor attempt is TERMINAL — runs once, no retry", async () => {
  let calls = 0;
  const result = await runWithExecutorRetry(
    async () => {
      calls++;
      return artifacts({ executorOk: false, executorTimedOut: true, failureReason: "timeout" });
    },
    { maxAttempts: 3, baseMs: 10, sleep: noSleep },
  );
  assert.equal(calls, 1, "timeout must not be retried");
  assert.equal(result.executorTimedOut, true);
  assert.equal(result.executorOk, false);
});

test("a transient (non-timeout) failure is retried up to maxAttempts", async () => {
  let calls = 0;
  const retries: number[] = [];
  const result = await runWithExecutorRetry(
    async () => {
      calls++;
      return artifacts({ executorOk: false, executorTimedOut: false, failureReason: "exit 1" });
    },
    { maxAttempts: 3, baseMs: 10, sleep: noSleep, onRetry: (a) => retries.push(a) },
  );
  assert.equal(calls, 3, "transient failure should exhaust all attempts");
  assert.deepEqual(retries, [1, 2]); // onRetry fires before each of the 2 retries
  assert.equal(result.executorOk, false);
});

test("a clean run returns immediately (single attempt)", async () => {
  let calls = 0;
  const result = await runWithExecutorRetry(
    async () => {
      calls++;
      return artifacts({ executorOk: true });
    },
    { maxAttempts: 3, baseMs: 10, sleep: noSleep },
  );
  assert.equal(calls, 1);
  assert.equal(result.executorOk, true);
});

test("a transient failure that then succeeds stops retrying at the success", async () => {
  let calls = 0;
  const result = await runWithExecutorRetry(
    async () => {
      calls++;
      return calls < 2
        ? artifacts({ executorOk: false, executorTimedOut: false, failureReason: "blip" })
        : artifacts({ executorOk: true });
    },
    { maxAttempts: 3, baseMs: 10, sleep: noSleep },
  );
  assert.equal(calls, 2);
  assert.equal(result.executorOk, true);
});

// --- Setup-bundle pre-step --------------------------------------------------

const claudeMd: Variant = { name: "cm", type: "claude-md", content: "" };
const copyBundle: Variant = {
  name: "cp",
  type: "bundle",
  install: "copy",
  claudeMdPath: "/x/CLAUDE.md",
  configDirPath: "/x/claude",
};
const setupBundle: Variant = {
  name: "gstack",
  type: "bundle",
  install: "setup",
  claudeMdPath: "/x/CLAUDE.md",
  setupCommand: "/opt/gstack/setup --local",
};

test("needsSetupPreStep: only setup bundles need the pre-step", () => {
  assert.equal(needsSetupPreStep(setupBundle), true);
  assert.equal(needsSetupPreStep(copyBundle), false);
  assert.equal(needsSetupPreStep(claudeMd), false);
});

const fakeResult = (over: Partial<ContainerResult> = {}): ContainerResult => ({
  stdout: "",
  stderr: "",
  exitCode: 0,
  timedOut: false,
  wallMs: 5,
  ...over,
});

test("runSetupPreStep: success when the setup populates .claude/skills", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bench-setup-"));
  const ws = path.join(dir, "workspace");
  const cell = path.join(dir, "cell");
  await fs.mkdir(path.join(ws, ".claude", "skills", "browse"), { recursive: true });
  await fs.mkdir(cell, { recursive: true });
  try {
    let called = 0;
    const result = await runSetupPreStep("SETUP", ws, cell, async () => {
      called++;
      return fakeResult({ stdout: "linked skills" });
    });
    assert.equal(called, 1, "setup runner should be invoked");
    assert.equal(result, null, "populated skills → success");
    // setup.log is written for observability.
    const log = await fs.readFile(path.join(cell, "setup.log"), "utf8");
    assert.match(log, /linked skills/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("runSetupPreStep: empty .claude/skills ⇒ failure reason (cell recorded failed)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bench-setup-"));
  const ws = path.join(dir, "workspace");
  const cell = path.join(dir, "cell");
  await fs.mkdir(ws, { recursive: true }); // no .claude/skills
  await fs.mkdir(cell, { recursive: true });
  try {
    const result = await runSetupPreStep("SETUP", ws, cell, async () =>
      fakeResult({ exitCode: 1, stderr: "playwright boom" }),
    );
    assert.match(result ?? "", /no skills registered/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// --- Sequential-memory mode -------------------------------------------------
//
// This also folds in the retired memory-persistence regression check: memory at
// project-scope <workspace>/.claude/memory/ must survive the per-step container
// reset (each step is a fresh --no-session-persistence context), which only holds
// if prepareWorkspace runs once and .claude/ is never re-materialized or committed.

test("runSequenceTask: memory persists across steps; per-step diffs are isolated", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bench-seq-"));
  const runResultsDir = path.join(root, "results");
  const taskDir = path.join(root, "task");
  await fs.mkdir(runResultsDir, { recursive: true });
  await fs.mkdir(taskDir, { recursive: true });

  const variant: Variant = { name: "cm", type: "claude-md", content: "# doctrine" };
  const task: Task = {
    dir: taskDir,
    prompt: "unused for a sequence task",
    meta: {
      id: "seqtask",
      title: "Sequence",
      logicBearing: true,
      securityRelevant: false,
      steps: [
        { prompt: "step one", id: "one" },
        { prompt: "step two", id: "two" },
      ],
    },
  };

  // Count prepareWorkspace invocations while delegating to the real impl — the
  // load-bearing invariant is "exactly once per sequence".
  let prepareCalls = 0;
  const prepare: typeof prepareWorkspace = async (...a) => {
    prepareCalls++;
    return prepareWorkspace(...a);
  };

  // Fake executor stands in for the container: it mutates the bind-mounted
  // workspace directly, exactly as the real agent would.
  let step2SawMemory = false;
  let memoryAtStep2 = "";
  const fakeExecutor: ExecutorRunner = async ({ workspaceDir, taskPrompt, onStdout }) => {
    onStdout?.('{"type":"result","subtype":"success"}\n');
    if (taskPrompt === "step one") {
      await fs.mkdir(path.join(workspaceDir, ".claude", "memory"), { recursive: true });
      await fs.writeFile(
        path.join(workspaceDir, ".claude", "memory", "note.md"),
        "remember: prices are integer cents",
      );
      await fs.mkdir(path.join(workspaceDir, "src"), { recursive: true });
      await fs.writeFile(path.join(workspaceDir, "src", "step1.ts"), "export const a = 1;\n");
    } else {
      // Step 2 runs in a FRESH context; prove step 1's memory survived the reset.
      memoryAtStep2 = await fs
        .readFile(path.join(workspaceDir, ".claude", "memory", "note.md"), "utf8")
        .catch(() => "");
      step2SawMemory = memoryAtStep2.length > 0;
      await fs.writeFile(path.join(workspaceDir, "src", "step2.ts"), "export const b = 2;\n");
    }
    return fakeResult({ stdout: "" });
  };

  try {
    const final = await runSequenceTask(variant, task, "sonnet", runResultsDir, {
      prepare,
      runExecutorFn: fakeExecutor,
    });

    // prepareWorkspace ran exactly once across the whole sequence.
    assert.equal(prepareCalls, 1, "prepareWorkspace must run exactly once");

    // Memory written in step 1 was readable in step 2's fresh context.
    assert.equal(step2SawMemory, true, "step 2 must read .claude/memory/note.md from step 1");
    assert.match(memoryAtStep2, /integer cents/);

    const cellDir = path.join(runResultsDir, "seqtask__cm__sonnet");
    const workspaceDir = path.join(cellDir, "workspace");

    // Per-step diff isolation: the FINAL (step 2) diff carries only step2's work,
    // never step 1's already-committed source change.
    assert.match(final.diff, /step2\.ts/, "final diff should contain step 2's file");
    assert.doesNotMatch(final.diff, /step1\.ts/, "final diff must NOT re-contain step 1's file");

    // Step 1's own diff is self-contained (regression guard on baseline ref = HEAD).
    const step1Diff = await fs.readFile(path.join(cellDir, "diff-step-1.patch"), "utf8");
    assert.match(step1Diff, /step1\.ts/);
    assert.doesNotMatch(step1Diff, /step2\.ts/);

    // Exclusion holds: memory is in NO captured diff...
    assert.doesNotMatch(final.diff, /note\.md/, "memory must never appear in a diff");
    assert.doesNotMatch(step1Diff, /note\.md/);
    // ...and it is never committed to git...
    const tracked = await git(workspaceDir, ["ls-files"]);
    assert.doesNotMatch(tracked, /\.claude/, "memory must not be tracked by git");
    // ...yet it IS present on disk for later steps to read.
    const onDisk = await fs.readFile(
      path.join(workspaceDir, ".claude", "memory", "note.md"),
      "utf8",
    );
    assert.match(onDisk, /integer cents/);

    // The final step's own executor succeeded.
    assert.equal(final.executorOk, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("runSequenceTask: a step's seedOverlay is applied before the step and excluded from its diff", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bench-overlay-"));
  const runResultsDir = path.join(root, "results");
  const taskDir = path.join(root, "task");
  await fs.mkdir(runResultsDir, { recursive: true });
  // The overlay fixture: a teammate-style migration that replaces the money module.
  await fs.mkdir(path.join(taskDir, "migrate", "src"), { recursive: true });
  await fs.writeFile(
    path.join(taskDir, "migrate", "src", "money.ts"),
    "export type Money = Decimal; // MIGRATED_TO_DECIMAL\n",
  );

  const variant: Variant = { name: "cm", type: "claude-md", content: "# doctrine" };
  const task: Task = {
    dir: taskDir,
    prompt: "unused for a sequence task",
    meta: {
      id: "overlaytask",
      title: "Overlay",
      logicBearing: true,
      securityRelevant: false,
      steps: [
        { prompt: "establish", id: "establish" },
        { prompt: "apply", id: "apply", seedOverlay: "migrate/" },
      ],
    },
  };

  let overlayPresentAtStep2 = false;
  let overlayContentAtStep2 = "";
  const fakeExecutor: ExecutorRunner = async ({ workspaceDir, taskPrompt, onStdout }) => {
    onStdout?.('{"type":"result","subtype":"success"}\n');
    if (taskPrompt === "establish") {
      await fs.mkdir(path.join(workspaceDir, "src"), { recursive: true });
      await fs.writeFile(
        path.join(workspaceDir, "src", "money.ts"),
        "export type Money = number; // integer cents\n",
      );
    } else {
      // The migration overlay must already be laid down when step 2 runs.
      overlayContentAtStep2 = await fs
        .readFile(path.join(workspaceDir, "src", "money.ts"), "utf8")
        .catch(() => "");
      overlayPresentAtStep2 = overlayContentAtStep2.includes("MIGRATED_TO_DECIMAL");
      // A genuine step-2 change the agent makes on top of the migrated code.
      await fs.writeFile(path.join(workspaceDir, "src", "reprice.ts"), "export const p = 1;\n");
    }
    return fakeResult({ stdout: "" });
  };

  try {
    const final = await runSequenceTask(variant, task, "sonnet", runResultsDir, {
      runExecutorFn: fakeExecutor,
    });

    // (a) The overlay file was present in the workspace when step 2 ran.
    assert.equal(overlayPresentAtStep2, true, "migration overlay must be present before step 2");

    // (b) The overlay's content is NOT in step 2's captured diff — it was committed
    // as the step's baseline, so the migration is never attributed to the agent.
    assert.doesNotMatch(
      final.diff,
      /MIGRATED_TO_DECIMAL/,
      "migration overlay must not appear in the agent's diff",
    );
    assert.doesNotMatch(final.diff, /money\.ts/, "the migrated module must not be in the diff");

    // (c) A genuine step-2 change IS in the diff.
    assert.match(final.diff, /reprice\.ts/, "the agent's own step-2 change must be in the diff");

    assert.equal(final.executorOk, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("runSequenceTask: a sequence with no steps degrades to a failed cell", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bench-seq-empty-"));
  const runResultsDir = path.join(root, "results");
  const taskDir = path.join(root, "task");
  await fs.mkdir(runResultsDir, { recursive: true });
  await fs.mkdir(taskDir, { recursive: true });

  const variant: Variant = { name: "cm", type: "claude-md", content: "" };
  const task: Task = {
    dir: taskDir,
    prompt: "unused",
    meta: { id: "empty", title: "Empty", logicBearing: false, securityRelevant: false },
  };

  let executorCalls = 0;
  const fakeExecutor: ExecutorRunner = async () => {
    executorCalls++;
    return fakeResult();
  };

  try {
    const res = await runSequenceTask(variant, task, "sonnet", runResultsDir, {
      runExecutorFn: fakeExecutor,
    });
    assert.equal(res.executorOk, false);
    assert.match(res.failureReason ?? "", /no steps/);
    assert.equal(executorCalls, 0, "no step ⇒ executor never invoked");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// --- Longitudinal-campaign mode ---------------------------------------------
//
// A campaign is a chain of N INDEPENDENTLY-JUDGED links sharing ONE workspace so
// `.claude/memory/` compounds across the whole chain. The runner returns EVERY
// link's artifacts (not just the last), and continues past a mid-chain failure.

test("runCampaign: memory compounds across the chain; per-link diffs are isolated; one entry per link", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bench-camp-"));
  const runResultsDir = path.join(root, "results");
  const taskDir = path.join(root, "task");
  await fs.mkdir(runResultsDir, { recursive: true });
  await fs.mkdir(taskDir, { recursive: true });

  const variant: Variant = { name: "cm", type: "claude-md", content: "# doctrine" };
  const task: Task = {
    dir: taskDir,
    prompt: "unused for a campaign task",
    meta: {
      id: "camptask",
      title: "Campaign",
      logicBearing: true,
      securityRelevant: false,
      campaign: [
        { prompt: "link one", id: "one" },
        { prompt: "link two", id: "two" },
        { prompt: "link three", id: "three" },
      ],
    },
  };

  let prepareCalls = 0;
  const prepare: typeof prepareWorkspace = async (...a) => {
    prepareCalls++;
    return prepareWorkspace(...a);
  };

  // The fake executor mutates the bind-mounted workspace directly, as the real
  // agent would. Link 1 writes memory + a tracked file; link 3 must READ the
  // memory link 1 wrote — proving it survived two fresh executor contexts.
  let link3SawMemory = false;
  let memoryAtLink3 = "";
  const fakeExecutor: ExecutorRunner = async ({ workspaceDir, taskPrompt, onStdout }) => {
    onStdout?.('{"type":"result","subtype":"success"}\n');
    if (taskPrompt === "link one") {
      await fs.mkdir(path.join(workspaceDir, ".claude", "memory"), { recursive: true });
      await fs.writeFile(
        path.join(workspaceDir, ".claude", "memory", "note.md"),
        "remember: prices are integer cents",
      );
      await fs.mkdir(path.join(workspaceDir, "src"), { recursive: true });
      await fs.writeFile(path.join(workspaceDir, "src", "link1.ts"), "export const a = 1;\n");
    } else if (taskPrompt === "link two") {
      await fs.writeFile(path.join(workspaceDir, "src", "link2.ts"), "export const b = 2;\n");
    } else {
      memoryAtLink3 = await fs
        .readFile(path.join(workspaceDir, ".claude", "memory", "note.md"), "utf8")
        .catch(() => "");
      link3SawMemory = memoryAtLink3.length > 0;
      await fs.writeFile(path.join(workspaceDir, "src", "link3.ts"), "export const c = 3;\n");
    }
    return fakeResult({ stdout: "" });
  };

  try {
    const results = await runCampaign(variant, task, "sonnet", runResultsDir, {
      prepare,
      runExecutorFn: fakeExecutor,
    });

    // prepareWorkspace ran exactly once across the whole chain.
    assert.equal(prepareCalls, 1, "prepareWorkspace must run exactly once");

    // One artifacts entry per link, in chain order, tagged with its identity.
    assert.equal(results.length, 3, "one entry per campaign link");
    assert.deepEqual(
      results.map((r) => [r.index, r.campaignTaskId]),
      [
        [0, "one"],
        [1, "two"],
        [2, "three"],
      ],
    );
    assert.ok(results.every((r) => r.artifacts.executorOk), "every link succeeded");

    // Memory written in link 1 was readable in link 3's fresh context.
    assert.equal(link3SawMemory, true, "link 3 must read link 1's .claude/memory/note.md");
    assert.match(memoryAtLink3, /integer cents/);

    const cellDir = path.join(runResultsDir, "camptask__cm__sonnet");
    const workspaceDir = path.join(cellDir, "workspace");

    // Per-link diff isolation: link 2's captured diff carries only link 2's work,
    // never link 1's already-committed source change.
    assert.match(results[1]!.artifacts.diff, /link2\.ts/, "link 2 diff has link 2's file");
    assert.doesNotMatch(
      results[1]!.artifacts.diff,
      /link1\.ts/,
      "link 2 diff must NOT re-contain link 1's committed file",
    );

    // Memory is in NO captured diff...
    for (const r of results) {
      assert.doesNotMatch(r.artifacts.diff, /note\.md/, "memory must never appear in a diff");
    }
    // ...it is never tracked by git...
    const tracked = await git(workspaceDir, ["ls-files"]);
    assert.doesNotMatch(tracked, /\.claude/, "memory must not be tracked by git");
    // ...yet it IS present on disk for later links to read.
    const onDisk = await fs.readFile(
      path.join(workspaceDir, ".claude", "memory", "note.md"),
      "utf8",
    );
    assert.match(onDisk, /integer cents/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("runCampaign: a mid-chain executor failure is captured AND the later link still runs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bench-camp-fail-"));
  const runResultsDir = path.join(root, "results");
  const taskDir = path.join(root, "task");
  await fs.mkdir(runResultsDir, { recursive: true });
  await fs.mkdir(taskDir, { recursive: true });

  const variant: Variant = { name: "cm", type: "claude-md", content: "" };
  const task: Task = {
    dir: taskDir,
    prompt: "unused",
    meta: {
      id: "campfail",
      title: "CampaignFail",
      logicBearing: true,
      securityRelevant: false,
      campaign: [
        { prompt: "first", id: "first" },
        { prompt: "middle", id: "middle" },
        { prompt: "last", id: "last" },
      ],
    },
  };

  let lastLinkRan = false;
  const fakeExecutor: ExecutorRunner = async ({ workspaceDir, taskPrompt, onStdout }) => {
    onStdout?.('{"type":"result","subtype":"success"}\n');
    if (taskPrompt === "first") {
      await fs.mkdir(path.join(workspaceDir, "src"), { recursive: true });
      await fs.writeFile(path.join(workspaceDir, "src", "first.ts"), "export const a = 1;\n");
      return fakeResult();
    }
    if (taskPrompt === "middle") {
      // The middle link's executor exits non-zero → a failed entry.
      return fakeResult({ exitCode: 1, stderr: "boom" });
    }
    lastLinkRan = true;
    await fs.writeFile(path.join(workspaceDir, "src", "last.ts"), "export const c = 3;\n");
    return fakeResult();
  };

  try {
    const results = await runCampaign(variant, task, "sonnet", runResultsDir, {
      runExecutorFn: fakeExecutor,
    });

    assert.equal(results.length, 3, "every link yields an entry, even the failed one");

    // First link succeeded; its result is NOT lost by the later failure.
    assert.equal(results[0]!.artifacts.executorOk, true);
    assert.match(results[0]!.artifacts.diff, /first\.ts/);

    // Middle link is a failed entry.
    assert.equal(results[1]!.campaignTaskId, "middle");
    assert.equal(results[1]!.artifacts.executorOk, false, "middle link recorded as failed");
    assert.match(results[1]!.artifacts.failureReason ?? "", /exited with code 1/);

    // The chain PROCEEDED: the last link still ran and was captured.
    assert.equal(lastLinkRan, true, "chain must continue past a mid-chain failure");
    assert.equal(results[2]!.artifacts.executorOk, true);
    assert.match(results[2]!.artifacts.diff, /last\.ts/);
    assert.doesNotMatch(results[2]!.artifacts.diff, /first\.ts/, "last link diff is isolated");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// --- Test execution (deterministic Correctness axis) --------------------------
//
// A task's optional testCommand runs in the workspace container AFTER a clean
// executor run, via the same SequenceDeps seam as runExecutorFn (runTestsFn?).
// No command, or a failed executor, leaves testResults undefined — downstream
// that absence means "no executable tests", never a failure.

/** Recording fake TestRunner: logs each call, returns a canned green result. */
function fakeTestRunner(calls: { workspaceDir: string; command: string }[]): TestRunner {
  return async (opts) => {
    calls.push({ workspaceDir: opts.workspaceDir, command: opts.command });
    return { command: opts.command, ok: true, passed: 3, failed: 0, raw: "# pass 3" };
  };
}

/** Scaffolding for a single-shot task cell in a temp dir. */
async function singleShotFixture(testCommand?: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bench-testexec-"));
  const runResultsDir = path.join(root, "results");
  const taskDir = path.join(root, "task");
  await fs.mkdir(runResultsDir, { recursive: true });
  await fs.mkdir(taskDir, { recursive: true });
  const task: Task = {
    dir: taskDir,
    prompt: "implement it",
    meta: {
      id: "single",
      title: "Single",
      logicBearing: true,
      securityRelevant: false,
      ...(testCommand ? { testCommand } : {}),
    },
  };
  return { root, runResultsDir, task };
}

test("single-shot: meta.testCommand runs AFTER a clean executor; testResults attached", async () => {
  const { root, runResultsDir, task } = await singleShotFixture("node --test");
  const variant: Variant = { name: "cm", type: "claude-md", content: "# doctrine" };

  const events: string[] = [];
  const fakeExecutor: ExecutorRunner = async ({ workspaceDir, onStdout }) => {
    events.push("executor");
    onStdout?.('{"type":"result","subtype":"success"}\n');
    await fs.mkdir(path.join(workspaceDir, "src"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "src", "impl.ts"), "export const a = 1;\n");
    return fakeResult({ stdout: "" });
  };
  const testCalls: { workspaceDir: string; command: string }[] = [];
  const runTestsFn: TestRunner = async (opts) => {
    events.push("tests");
    testCalls.push({ workspaceDir: opts.workspaceDir, command: opts.command });
    return { command: opts.command, ok: true, passed: 3, failed: 0, raw: "# pass 3" };
  };

  try {
    const res = await runVariantTask(variant, task, "sonnet", runResultsDir, {
      runExecutorFn: fakeExecutor,
      runTestsFn,
    });
    assert.equal(res.executorOk, true);
    assert.deepEqual(events, ["executor", "tests"], "tests run after the executor finishes");
    assert.equal(testCalls.length, 1);
    assert.equal(testCalls[0]!.command, "node --test");
    assert.equal(testCalls[0]!.workspaceDir, res.workspaceDir, "tests run in the cell's workspace");
    assert.deepEqual(res.testResults, {
      command: "node --test",
      ok: true,
      passed: 3,
      failed: 0,
      raw: "# pass 3",
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("single-shot: no testCommand ⇒ runTests never invoked, testResults undefined", async () => {
  const { root, runResultsDir, task } = await singleShotFixture(undefined);
  const variant: Variant = { name: "cm", type: "claude-md", content: "" };
  const fakeExecutor: ExecutorRunner = async ({ onStdout }) => {
    onStdout?.('{"type":"result","subtype":"success"}\n');
    return fakeResult({ stdout: "" });
  };
  const testCalls: { workspaceDir: string; command: string }[] = [];

  try {
    const res = await runVariantTask(variant, task, "sonnet", runResultsDir, {
      runExecutorFn: fakeExecutor,
      runTestsFn: fakeTestRunner(testCalls),
    });
    assert.equal(res.executorOk, true);
    assert.equal(testCalls.length, 0, "no command ⇒ no test container");
    assert.equal(res.testResults, undefined);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("single-shot: executor failure ⇒ tests skipped (nothing meaningful to test)", async () => {
  const { root, runResultsDir, task } = await singleShotFixture("node --test");
  const variant: Variant = { name: "cm", type: "claude-md", content: "" };
  // A timeout is TERMINAL in the retry logic, so this stays a single fast attempt.
  const fakeExecutor: ExecutorRunner = async () =>
    fakeResult({ exitCode: null, timedOut: true });
  const testCalls: { workspaceDir: string; command: string }[] = [];

  try {
    const res = await runVariantTask(variant, task, "sonnet", runResultsDir, {
      runExecutorFn: fakeExecutor,
      runTestsFn: fakeTestRunner(testCalls),
    });
    assert.equal(res.executorOk, false);
    assert.equal(testCalls.length, 0, "failed executor ⇒ no test container");
    assert.equal(res.testResults, undefined);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("single-shot: a runTests crash degrades to ok:false — never kills the cell", async () => {
  const { root, runResultsDir, task } = await singleShotFixture("node --test");
  const variant: Variant = { name: "cm", type: "claude-md", content: "" };
  const fakeExecutor: ExecutorRunner = async ({ onStdout }) => {
    onStdout?.('{"type":"result","subtype":"success"}\n');
    return fakeResult({ stdout: "" });
  };
  const runTestsFn: TestRunner = async () => {
    throw new Error("docker daemon exploded");
  };

  try {
    const res = await runVariantTask(variant, task, "sonnet", runResultsDir, {
      runExecutorFn: fakeExecutor,
      runTestsFn,
    });
    assert.equal(res.executorOk, true, "the cell itself survives");
    assert.deepEqual(res.testResults, {
      command: "node --test",
      ok: false,
      raw: "docker daemon exploded",
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("runSequenceTask: meta.testCommand runs ONCE against the FINAL workspace state", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bench-seq-tests-"));
  const runResultsDir = path.join(root, "results");
  const taskDir = path.join(root, "task");
  await fs.mkdir(runResultsDir, { recursive: true });
  await fs.mkdir(taskDir, { recursive: true });

  const variant: Variant = { name: "cm", type: "claude-md", content: "" };
  const task: Task = {
    dir: taskDir,
    prompt: "unused for a sequence task",
    meta: {
      id: "seqtests",
      title: "SequenceTests",
      logicBearing: true,
      securityRelevant: false,
      testCommand: "node --test",
      steps: [
        { prompt: "step one", id: "one" },
        { prompt: "step two", id: "two" },
      ],
    },
  };

  const events: string[] = [];
  const fakeExecutor: ExecutorRunner = async ({ workspaceDir, taskPrompt, onStdout }) => {
    events.push(taskPrompt);
    onStdout?.('{"type":"result","subtype":"success"}\n');
    await fs.mkdir(path.join(workspaceDir, "src"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, "src", `${taskPrompt.replace(/\s+/g, "-")}.ts`),
      "export {};\n",
    );
    return fakeResult({ stdout: "" });
  };
  const testCalls: { workspaceDir: string; command: string }[] = [];
  const runTestsFn: TestRunner = async (opts) => {
    events.push("tests");
    testCalls.push({ workspaceDir: opts.workspaceDir, command: opts.command });
    return { command: opts.command, ok: true, raw: "# pass 1" };
  };

  try {
    const final = await runSequenceTask(variant, task, "sonnet", runResultsDir, {
      runExecutorFn: fakeExecutor,
      runTestsFn,
    });
    // Exactly one test run, and only after EVERY step has finished.
    assert.deepEqual(events, ["step one", "step two", "tests"]);
    assert.equal(testCalls.length, 1);
    assert.equal(testCalls[0]!.command, "node --test");
    assert.equal(testCalls[0]!.workspaceDir, final.workspaceDir);
    assert.deepEqual(final.testResults, { command: "node --test", ok: true, raw: "# pass 1" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("runCampaign: per-link testCommand overrides meta-level; failed link skips tests", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bench-camp-tests-"));
  const runResultsDir = path.join(root, "results");
  const taskDir = path.join(root, "task");
  await fs.mkdir(runResultsDir, { recursive: true });
  await fs.mkdir(taskDir, { recursive: true });

  const variant: Variant = { name: "cm", type: "claude-md", content: "" };
  const task: Task = {
    dir: taskDir,
    prompt: "unused",
    meta: {
      id: "camptests",
      title: "CampaignTests",
      logicBearing: true,
      securityRelevant: false,
      testCommand: "npm test",
      campaign: [
        { prompt: "link one", id: "one" }, // inherits the meta-level command
        { prompt: "link two", id: "two", testCommand: "npm run test:wide" }, // override wins
        { prompt: "link three", id: "three" }, // executor fails ⇒ tests skipped
      ],
    },
  };

  const fakeExecutor: ExecutorRunner = async ({ workspaceDir, taskPrompt, onStdout }) => {
    onStdout?.('{"type":"result","subtype":"success"}\n');
    if (taskPrompt === "link three") return fakeResult({ exitCode: 1, stderr: "boom" });
    await fs.mkdir(path.join(workspaceDir, "src"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, "src", `${taskPrompt.replace(/\s+/g, "-")}.ts`),
      "export {};\n",
    );
    return fakeResult({ stdout: "" });
  };
  const testCalls: { workspaceDir: string; command: string }[] = [];

  try {
    const results = await runCampaign(variant, task, "sonnet", runResultsDir, {
      runExecutorFn: fakeExecutor,
      runTestsFn: fakeTestRunner(testCalls),
    });

    assert.equal(results.length, 3);
    // One test container per SUCCESSFUL link, with the resolved command.
    assert.deepEqual(
      testCalls.map((c) => c.command),
      ["npm test", "npm run test:wide"],
    );
    assert.equal(results[0]!.testResults?.command, "npm test");
    assert.equal(results[1]!.testResults?.command, "npm run test:wide", "link override wins");
    // The failed link has NO verdict — absence, not a fabricated failure.
    assert.equal(results[2]!.artifacts.executorOk, false);
    assert.equal(results[2]!.testResults, undefined);
    // Every test run happened in the shared campaign workspace.
    for (const c of testCalls) {
      assert.equal(c.workspaceDir, results[0]!.artifacts.workspaceDir);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
