import fs from "node:fs/promises";
import path from "node:path";
import { createWriteStream } from "node:fs";
import { captureArtifacts } from "./capture.js";
import { EXECUTOR_MAX_ATTEMPTS, RETRY_BASE_MS, WORKSPACE_CONFIG_DIR } from "./config.js";
import { runExecutor, runSetup } from "./docker.js";
import type { ContainerResult } from "./docker.js";
import { extractLastResultEvent, parseCallMetrics } from "./metrics.js";
import { withRetry } from "./retry.js";
import { commitStep, git, prepareWorkspace, resolveWithin } from "./workspace.js";
import type {
  CallMetrics,
  RunArtifacts,
  SetupBundleVariant,
  Task,
  Variant,
} from "./types.js";

/** The setup runner shape — injectable so the pre-step logic is unit-testable. */
export type SetupRunner = (args: {
  workspaceDir: string;
  setupCommand: string;
}) => Promise<ContainerResult>;

/** True (type-guard) when a variant needs a setup pre-step before the executor. */
export function needsSetupPreStep(variant: Variant): variant is SetupBundleVariant {
  return variant.type === "bundle" && variant.install === "setup";
}

/**
 * Run a setup-bundle's pre-step container and verify it populated the skills
 * dir. Writes setup.log to the cell dir. Returns a failure reason string if the
 * bundle failed to install (empty skills dir, container error/timeout), or null
 * on success. Treats "skills dir populated" as success even if the container
 * exits non-zero on an optional step.
 */
export async function runSetupPreStep(
  setupCommand: string,
  workspaceDir: string,
  cellDir: string,
  runSetupFn: SetupRunner = runSetup,
): Promise<string | null> {
  let res;
  try {
    res = await runSetupFn({ workspaceDir, setupCommand });
  } catch (err) {
    await fs
      .writeFile(path.join(cellDir, "setup.log"), `setup spawn error: ${(err as Error).message}\n`)
      .catch(() => {});
    return `bundle setup failed: ${(err as Error).message}`;
  }

  await fs
    .writeFile(
      path.join(cellDir, "setup.log"),
      `# setup wallMs=${res.wallMs} exitCode=${res.exitCode} timedOut=${res.timedOut}\n\n` +
        `===== STDOUT =====\n${res.stdout}\n===== STDERR =====\n${res.stderr}\n`,
    )
    .catch(() => {});

  // Success = the skills dir is populated (check presence, not exit code).
  const skillsDir = path.join(workspaceDir, WORKSPACE_CONFIG_DIR, "skills");
  const skills = await fs.readdir(skillsDir).catch(() => [] as string[]);
  if (skills.length === 0) {
    return `bundle setup failed: no skills registered in .claude/skills (exit ${res.exitCode}, timedOut=${res.timedOut})`;
  }
  return null;
}

/**
 * Run one (variant × task) exactly once: prepare a FRESH isolated workspace,
 * invoke the executor, tee the NDJSON trace, then capture artifacts. Returns
 * artifacts with executorOk=false (never throws) on any failure. A fresh
 * workspace per call is what makes a retry safe — the executor mutates /work.
 */
async function runOnce(
  variant: Variant,
  task: Task,
  executorModel: string,
  runResultsDir: string,
): Promise<RunArtifacts> {
  const { cellId, cellDir, workspaceDir } = await prepareWorkspace(
    variant,
    task,
    executorModel,
    runResultsDir,
  );

  // Setup-bundle pre-step: register skills into <workspace>/.claude BEFORE the
  // executor runs. If it leaves the skills dir empty, the bundle didn't install
  // — record a failed cell (skips the judge) rather than run a misleading exec.
  if (needsSetupPreStep(variant)) {
    const failure = await runSetupPreStep(variant.setupCommand, workspaceDir, cellDir);
    if (failure) {
      return {
        cellId,
        variant: variant.name,
        taskId: task.meta.id,
        workspaceDir,
        diff: "",
        changedFiles: [],
        transcript: "",
        testFilesPresent: false,
        executorModel,
        executorMetrics: { wallMs: 0 },
        executorOk: false,
        executorTimedOut: false,
        failureReason: failure,
      };
    }
  }

  const tracePath = path.join(cellDir, "trace.ndjson");
  const traceStream = createWriteStream(tracePath, { flags: "a" });

  let executorOk = false;
  let executorTimedOut = false;
  let failureReason: string | undefined;
  let wallMs = 0;

  try {
    const result = await runExecutor({
      workspaceDir,
      taskPrompt: task.prompt,
      model: executorModel,
      onStdout: (chunk) => traceStream.write(chunk),
    });
    wallMs = result.wallMs;

    if (result.timedOut) {
      executorTimedOut = true;
      failureReason = "Executor timed out and the container was killed.";
    } else if (result.exitCode !== 0) {
      failureReason = `Executor exited with code ${result.exitCode}. stderr: ${result.stderr.slice(0, 500)}`;
    } else {
      executorOk = true;
    }
  } catch (err) {
    failureReason = `Executor invocation error: ${(err as Error).message}`;
  } finally {
    await new Promise<void>((resolve) => traceStream.end(() => resolve()));
  }

  const ndjson = await fs.readFile(tracePath, "utf8").catch(() => "");
  // Metrics come from the final result event in the stream plus host wall-clock.
  const executorMetrics: CallMetrics = parseCallMetrics(
    extractLastResultEvent(ndjson),
    wallMs,
  );

  // Capture (git diff, classification, redaction) can itself fail — e.g. a git
  // error or an oversized diff. A capture failure must degrade only this one run
  // to failed, never abort the whole matrix, so it is guarded here.
  try {
    return await captureArtifacts({
      cellId,
      variant: variant.name,
      taskId: task.meta.id,
      cellDir,
      workspaceDir,
      ndjson,
      executorModel,
      executorOk,
      executorTimedOut,
      executorMetrics,
      ...(failureReason ? { failureReason } : {}),
    });
  } catch (err) {
    return {
      cellId,
      variant: variant.name,
      taskId: task.meta.id,
      workspaceDir,
      diff: "",
      changedFiles: [],
      transcript: "",
      testFilesPresent: false,
      executorModel,
      executorMetrics,
      executorOk: false,
      executorTimedOut,
      failureReason: `Capture failed: ${(err as Error).message}`,
    };
  }
}

/**
 * Run one (variant × task) with retry on transient failure. Each attempt gets a
 * fresh workspace via runOnce. A clean run (executorOk=true) returns immediately
 * — few/no changes is a real result, not a failure, so it is never retried.
 *
 * A TIMEOUT is TERMINAL: it almost always means the session hung (usually API
 * rate-limiting), so retrying would burn another full timeout for nothing — we
 * record the failed run and move on. Genuine transient failures (spawn error, or
 * a non-timeout non-zero exit / capture failure) still retry up to
 * EXECUTOR_MAX_ATTEMPTS.
 */
/**
 * Retry orchestration for the executor, separated from I/O so the terminal-vs-
 * retryable decision is unit-testable with an injected `runOnce`. A clean run OR
 * a timeout is terminal (returned without a retry); every other failure throws
 * to trigger a retry. Returns the last artifacts even when all attempts fail so
 * the matrix continues via the judge's failure path.
 */
export async function runWithExecutorRetry(
  runOnceFn: () => Promise<RunArtifacts>,
  opts: {
    maxAttempts: number;
    baseMs: number;
    sleep?: (ms: number) => Promise<void>;
    onRetry?: (failedAttempt: number, err: Error) => void;
  },
): Promise<RunArtifacts> {
  let lastArtifacts: RunArtifacts | undefined;
  try {
    const { value } = await withRetry(
      async () => {
        const artifacts = await runOnceFn();
        lastArtifacts = artifacts;
        // Terminal cases return without throwing so withRetry stops immediately:
        // a clean run, OR a timeout (non-retryable — a hung/rate-limited session
        // would just burn another full timeout). Everything else throws to retry.
        if (!artifacts.executorOk && !artifacts.executorTimedOut) {
          throw new Error(artifacts.failureReason ?? "executor failed");
        }
        return artifacts;
      },
      {
        maxAttempts: opts.maxAttempts,
        baseMs: opts.baseMs,
        ...(opts.sleep ? { sleep: opts.sleep } : {}),
        ...(opts.onRetry ? { onRetry: opts.onRetry } : {}),
      },
    );
    return value;
  } catch {
    return lastArtifacts!;
  }
}

export async function runVariantTask(
  variant: Variant,
  task: Task,
  executorModel: string,
  runResultsDir: string,
): Promise<RunArtifacts> {
  return runWithExecutorRetry(() => runOnce(variant, task, executorModel, runResultsDir), {
    maxAttempts: EXECUTOR_MAX_ATTEMPTS,
    baseMs: RETRY_BASE_MS,
    onRetry: (failedAttempt, err) =>
      console.error(
        `  executor attempt ${failedAttempt + 1}/${EXECUTOR_MAX_ATTEMPTS} after failure: ${err.message.slice(0, 120)}`,
      ),
  });
}

// --- Sequential-memory mode -------------------------------------------------

/** The executor runner shape — injectable so the sequence loop is unit-testable
 *  without spawning real containers. */
export type ExecutorRunner = typeof runExecutor;

/** Injectable seams for {@link runSequenceTask} (tests only; real deps default). */
export interface SequenceDeps {
  prepare?: typeof prepareWorkspace;
  runExecutorFn?: ExecutorRunner;
}

/** Build a failed-cell RunArtifacts (no diff/transcript) — the sequence path's
 *  equivalent of runOnce's failure return, so the judge skips a broken cell. */
function failedCell(
  cellId: string,
  variant: Variant,
  taskId: string,
  workspaceDir: string,
  executorModel: string,
  failureReason: string,
): RunArtifacts {
  return {
    cellId,
    variant: variant.name,
    taskId,
    workspaceDir,
    diff: "",
    changedFiles: [],
    transcript: "",
    testFilesPresent: false,
    executorModel,
    executorMetrics: { wallMs: 0 },
    executorOk: false,
    executorTimedOut: false,
    failureReason,
  };
}

/**
 * Run ONE step of a sequence against an already-prepared workspace: invoke the
 * executor, tee that step's NDJSON into `trace-step-<n>.ndjson`, then capture its
 * artifacts diffing against `baselineRef` (the previous step's commit). Mirrors
 * runOnce's single-cell body but never touches prepareWorkspace — the workspace,
 * and its accumulating `.claude/memory/`, is shared across steps. Never throws:
 * an executor/capture failure degrades this step to executorOk=false.
 */
async function runExecutorStep(args: {
  cellId: string;
  variant: Variant;
  taskId: string;
  cellDir: string;
  workspaceDir: string;
  prompt: string;
  stepNum: number;
  baselineRef: string;
  executorModel: string;
  runExecutorFn: ExecutorRunner;
}): Promise<RunArtifacts> {
  const { cellId, variant, taskId, cellDir, workspaceDir, executorModel } = args;
  const tracePath = path.join(cellDir, `trace-step-${args.stepNum}.ndjson`);
  const traceStream = createWriteStream(tracePath, { flags: "a" });

  let executorOk = false;
  let executorTimedOut = false;
  let failureReason: string | undefined;
  let wallMs = 0;

  try {
    const result = await args.runExecutorFn({
      workspaceDir,
      taskPrompt: args.prompt,
      model: executorModel,
      onStdout: (chunk) => traceStream.write(chunk),
    });
    wallMs = result.wallMs;

    if (result.timedOut) {
      executorTimedOut = true;
      failureReason = "Executor timed out and the container was killed.";
    } else if (result.exitCode !== 0) {
      failureReason = `Executor exited with code ${result.exitCode}. stderr: ${result.stderr.slice(0, 500)}`;
    } else {
      executorOk = true;
    }
  } catch (err) {
    failureReason = `Executor invocation error: ${(err as Error).message}`;
  } finally {
    await new Promise<void>((resolve) => traceStream.end(() => resolve()));
  }

  const ndjson = await fs.readFile(tracePath, "utf8").catch(() => "");
  const executorMetrics: CallMetrics = parseCallMetrics(extractLastResultEvent(ndjson), wallMs);

  try {
    return await captureArtifacts({
      cellId,
      variant: variant.name,
      taskId,
      cellDir,
      workspaceDir,
      ndjson,
      executorModel,
      executorOk,
      executorTimedOut,
      executorMetrics,
      baselineRef: args.baselineRef,
      ...(failureReason ? { failureReason } : {}),
    });
  } catch (err) {
    return failedCell(
      cellId,
      variant,
      taskId,
      workspaceDir,
      executorModel,
      `Capture failed: ${(err as Error).message}`,
    );
  }
}

/**
 * Lay a step's seed overlay over the workspace, overwriting existing files. The
 * overlay is a teammate-style migration (e.g. money integer-cents → Decimal): it
 * replaces modules BEFORE a step runs so memory formed by an earlier step becomes
 * stale. Source (`<taskDir>/<seedOverlay>/`) and every destination are validated
 * with resolveWithin so a malformed/hostile overlay path cannot read or write
 * outside its sandbox. Recurses subdirs and mkdir's parents.
 */
async function applySeedOverlay(
  taskDir: string,
  seedOverlay: string,
  workspaceDir: string,
): Promise<void> {
  const overlayRoot = resolveWithin(taskDir, seedOverlay);

  async function copyDir(srcDir: string, relBase: string): Promise<void> {
    const entries = await fs.readdir(srcDir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = relBase ? path.join(relBase, entry.name) : entry.name;
      const src = path.join(srcDir, entry.name);
      if (entry.isDirectory()) {
        await copyDir(src, rel);
      } else if (entry.isFile()) {
        // Re-validate both ends against their bases for every file.
        resolveWithin(overlayRoot, rel);
        const dest = resolveWithin(workspaceDir, rel);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.copyFile(src, dest);
      }
    }
  }

  await copyDir(overlayRoot, "");
}

/**
 * Run a sequential-memory task: its ordered `task.meta.steps` execute in a SINGLE
 * persistent workspace so a bundle's project-scope `.claude/memory/` carries
 * knowledge from one step into the next.
 *
 * The load-bearing invariant: prepareWorkspace runs EXACTLY ONCE (git init +
 * baseline + variant `.claude/` copy + exclude registration). Each step then runs
 * as a fresh executor context (docker uses --no-session-persistence) against the
 * same `workspaceDir`; between steps we `git add -A && commit` the step's tracked
 * work so the next step's diff is isolated, but `.claude/` is excluded from git so
 * accumulated memory is never committed and survives on the bind mount. Returns
 * the FINAL step's artifacts — what the judge and anchor detectors consume.
 */
export async function runSequenceTask(
  variant: Variant,
  task: Task,
  executorModel: string,
  runResultsDir: string,
  deps: SequenceDeps = {},
): Promise<RunArtifacts> {
  const prepare = deps.prepare ?? prepareWorkspace;
  const runExecutorFn = deps.runExecutorFn ?? runExecutor;

  // ONCE: any re-prepare between steps would wipe accumulated memory.
  const { cellId, cellDir, workspaceDir } = await prepare(
    variant,
    task,
    executorModel,
    runResultsDir,
  );

  // Exclude the ENTIRE `.claude/` tree from every step commit UNCONDITIONALLY
  // (prepareWorkspace only does this for bundle variants). In a sequence, memory
  // accumulates under `<workspace>/.claude/memory/` for ANY variant; if it were
  // committed it would leak into a step's captured diff and be scored as the
  // agent's work — the very invariant this mode depends on. Registered in
  // .git/info/exclude (not global gitignore) so the exclusion is hermetic and
  // reproducible on any host, not dependent on the runner's ~/.config/git/ignore.
  await fs.appendFile(
    path.join(workspaceDir, ".git", "info", "exclude"),
    `\n${WORKSPACE_CONFIG_DIR}/\n`,
  );

  // Setup-bundle pre-step: register skills into <workspace>/.claude ONCE, before
  // any step runs. A failed install records a failed cell (skips the judge).
  if (needsSetupPreStep(variant)) {
    const failure = await runSetupPreStep(variant.setupCommand, workspaceDir, cellDir);
    if (failure) {
      return failedCell(cellId, variant, task.meta.id, workspaceDir, executorModel, failure);
    }
  }

  const steps = task.meta.steps ?? [];
  if (steps.length === 0) {
    return failedCell(
      cellId,
      variant,
      task.meta.id,
      workspaceDir,
      executorModel,
      "Sequence task has no steps.",
    );
  }

  // First step diffs against the prepareWorkspace baseline commit; each later
  // step diffs against the commit the previous step produced.
  let baselineRef = (await git(workspaceDir, ["rev-parse", "HEAD"])).trim();
  let finalArtifacts!: RunArtifacts;
  // A non-final step failing is load-bearing: if the "establish" step never ran,
  // no memory was formed and the final step's anchor verdict is meaningless. We
  // record the FIRST such failure and, if the final step nonetheless looks OK,
  // demote the returned cell to failed so a silent junk result can't be scored.
  let priorStepFailure: string | undefined;

  for (let i = 0; i < steps.length; i++) {
    const stepNum = i + 1;
    const isFinal = stepNum === steps.length;

    // Apply this step's seed overlay BEFORE running it, then commit that overlay
    // as the step's BASELINE. Ordering is load-bearing: overlay → commit(migration)
    // → baselineRef = migration commit → run step → capture (diffs vs baselineRef,
    // so the migration is NOT in the agent's diff). The migration is a teammate's
    // work, never the agent's — it must never be attributed to the agent.
    const overlay = steps[i]!.seedOverlay;
    if (overlay) {
      await applySeedOverlay(task.dir, overlay, workspaceDir);
      baselineRef = await commitStep(workspaceDir, `migrate before step ${stepNum}`);
    }

    const artifacts = await runExecutorStep({
      cellId,
      variant,
      taskId: task.meta.id,
      cellDir,
      workspaceDir,
      prompt: steps[i]!.prompt,
      stepNum,
      baselineRef,
      executorModel,
      runExecutorFn,
    });

    if (!isFinal && !artifacts.executorOk && priorStepFailure === undefined) {
      priorStepFailure = `step ${stepNum} failed: ${artifacts.failureReason ?? "executor error"}`;
    }

    // Keep the per-step diff (final also lands in the canonical diff.patch that
    // captureArtifacts writes; each step overwrites it, so retain a copy here).
    await fs
      .writeFile(path.join(cellDir, `diff-step-${stepNum}.patch`), artifacts.diff)
      .catch(() => {});

    // Commit this step's tracked work so the next step's diff is isolated. This
    // does NOT stage `.claude/` (excluded), so memory persists uncommitted.
    baselineRef = await commitStep(workspaceDir, `step ${stepNum}`);
    finalArtifacts = artifacts;
  }

  // Surface an earlier-step failure that the final step's own status would hide.
  if (priorStepFailure !== undefined && finalArtifacts.executorOk) {
    finalArtifacts = {
      ...finalArtifacts,
      executorOk: false,
      failureReason: `Earlier ${priorStepFailure}; final-step result is unreliable (memory may never have been established).`,
    };
  }

  return finalArtifacts;
}
