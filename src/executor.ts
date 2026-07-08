import fs from "node:fs/promises";
import path from "node:path";
import { createWriteStream } from "node:fs";
import { captureArtifacts } from "./capture.js";
import { EXECUTOR_MAX_ATTEMPTS, RETRY_BASE_MS, WORKSPACE_CONFIG_DIR } from "./config.js";
import { runExecutor, runSetup } from "./docker.js";
import type { ContainerResult } from "./docker.js";
import { extractLastResultEvent, parseCallMetrics } from "./metrics.js";
import { withRetry } from "./retry.js";
import { prepareWorkspace } from "./workspace.js";
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
