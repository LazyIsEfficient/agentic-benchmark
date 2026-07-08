import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { needsSetupPreStep, runSetupPreStep, runWithExecutorRetry } from "./executor.js";
import type { ContainerResult } from "./docker.js";
import type { RunArtifacts, Variant } from "./types.js";

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
