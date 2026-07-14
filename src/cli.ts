import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_CONCURRENCY,
  EXECUTOR_MODEL,
  INTER_CELL_DELAY_MS,
  JUDGE_MODEL,
  OAUTH_TOKEN_ENV,
  PROMPTS_DIR,
  REPORTS_DIR,
  TASKS_DIR,
} from "./config.js";
import { hasOAuthToken } from "./auth.js";
import { checkAuth } from "./docker.js";
import { formatExecLine } from "./metrics.js";
import { runPool } from "./pool.js";
import { sleep } from "./retry.js";
import { runCampaign, runSequenceTask, runVariantTask } from "./executor.js";
import { detectAnchor } from "./anchors.js";
import { buildFailureResult, judgeRun, writeRunResult } from "./judge.js";
import { regenerateReport, writeReport } from "./report.js";
import { buildRunFolderName } from "./runmeta.js";
import { parseVariantManifest } from "./variant.js";
import { resolveWithin } from "./workspace.js";
import type {
  AnchorConfig,
  CampaignResult,
  CampaignTask,
  CampaignTaskResult,
  Report,
  Task,
  TaskMeta,
  TaskStep,
  Variant,
  VariantTaskResult,
} from "./types.js";

// --- Loaders ----------------------------------------------------------------

export async function loadVariants(): Promise<Variant[]> {
  const entries = await fs.readdir(PROMPTS_DIR, { withFileTypes: true });
  const variants: Variant[] = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory()) continue;
    const dir = path.join(PROMPTS_DIR, e.name);

    // Read the optional manifest; absent ⇒ claude-md defaults (today's behavior).
    const rawManifest = await fs.readFile(path.join(dir, "variant.json"), "utf8").catch(() => null);
    const manifest =
      rawManifest === null
        ? parseVariantManifest({})
        : parseVariantManifest(JSON.parse(rawManifest));

    if (manifest.type === "bundle") {
      const claudeMdPath = path.join(dir, manifest.claudeMd);
      const hasClaudeMd = await fs.stat(claudeMdPath).then((s) => s.isFile()).catch(() => false);
      if (!hasClaudeMd) {
        throw new Error(`Bundle variant "${e.name}" is missing ${manifest.claudeMd}.`);
      }
      const description = manifest.description;

      if (manifest.install === "setup") {
        // Source is baked in the image; only the CLAUDE.md is vendored here.
        variants.push({
          name: e.name,
          type: "bundle",
          install: "setup",
          claudeMdPath,
          setupCommand: manifest.setupCommand!,
          ...(description !== undefined ? { description } : {}),
        });
        continue;
      }

      // copy: the vendored .claude/ tree must be present to copy in.
      const configDirPath = path.join(dir, manifest.configDir);
      const hasConfigDir = await fs.stat(configDirPath).then((s) => s.isDirectory()).catch(() => false);
      if (!hasConfigDir) {
        throw new Error(`Copy bundle "${e.name}" is missing ${manifest.configDir}/.`);
      }
      variants.push({
        name: e.name,
        type: "bundle",
        install: "copy",
        claudeMdPath,
        configDirPath,
        ...(description !== undefined ? { description } : {}),
      });
      continue;
    }

    // claude-md: read the CLAUDE.md content (skip dirs without one).
    const content = await fs.readFile(path.join(dir, manifest.claudeMd), "utf8").catch(() => null);
    if (content === null) continue;
    variants.push({
      name: e.name,
      type: "claude-md",
      content,
      ...(manifest.description !== undefined ? { description: manifest.description } : {}),
    });
  }
  return variants;
}

/** One `--list` line: `  - <name> [<type>] — <description?>`. Pure/testable. */
export function formatVariantListLine(v: Variant): string {
  const desc = v.description ? ` — ${v.description}` : "";
  return `  - ${v.name} [${v.type}]${desc}`;
}

/**
 * On-disk shape of a `meta.json` step entry: a task-dir-relative `file` ref,
 * not the resolved prompt. loadTasks reads each `file` into the runtime
 * {@link TaskStep}'s `prompt`, carrying `id`/`seedOverlay` through.
 */
interface TaskStepDto {
  id?: string;
  file: string;
  seedOverlay?: string;
}

/**
 * On-disk shape of a `meta.json` campaign entry: a task-dir-relative `file` ref
 * (not the resolved prompt), plus the link's `id` and optional deterministic
 * `anchor`. loadTasks reads each `file` into the runtime {@link CampaignTask}'s
 * `prompt`, carrying `id`/`anchor` through. Mirrors {@link TaskStepDto}.
 */
interface CampaignTaskDto {
  id?: string;
  file: string;
  anchor?: AnchorConfig;
}

export async function loadTasks(tasksDir: string = TASKS_DIR): Promise<Task[]> {
  const entries = await fs.readdir(tasksDir, { withFileTypes: true });
  const tasks: Task[] = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory()) continue;
    const dir = path.join(tasksDir, e.name);
    // Skip dirs that aren't a task yet (no meta.json) — mirrors loadVariants
    // skipping dirs without a CLAUDE.md, so an in-progress task dir doesn't
    // break the whole load. A malformed meta.json still throws (real error).
    const rawMeta = await fs.readFile(path.join(dir, "meta.json"), "utf8").catch(() => null);
    if (rawMeta === null) continue;
    const meta = JSON.parse(rawMeta) as TaskMeta;

    // `steps` (sequence) and `campaign` (longitudinal) are mutually exclusive
    // modes. Declaring both is a misconfig: the `steps` branch would win and leave
    // `meta.campaign` as raw DTOs (no resolved prompts) that main() then mis-routes
    // into the campaign lane with undefined prompts. Fail loud at load instead.
    const mAny = meta as { steps?: unknown[]; campaign?: unknown[] };
    if (mAny.steps?.length && mAny.campaign?.length) {
      throw new Error(`Task "${meta.id}": a task cannot declare both "steps" and "campaign".`);
    }

    // Sequence task: `meta.steps` present ⇒ resolve each step's `file`
    // (task-dir-relative) into its prompt, carrying id/seedOverlay through, and
    // write the resolved TaskStep[] back onto meta so runSequenceTask reads
    // prompts. `steps` WINS over any task.md — the poison fixture ships a
    // redundant one, which we deliberately ignore. Task.prompt is the FINAL
    // step's prompt: the judge scores the final step, and judgeRun uses
    // task.prompt as the task context, so it must see the final step's ask.
    const rawSteps = (meta as { steps?: TaskStepDto[] }).steps;
    if (rawSteps && rawSteps.length > 0) {
      const steps: TaskStep[] = [];
      for (const s of rawSteps) {
        // Validate the task-controlled `file` ref stays inside the task dir —
        // a malformed/hostile meta.json must not read arbitrary host files.
        const prompt = await fs.readFile(resolveWithin(dir, s.file), "utf8");
        steps.push({
          prompt,
          ...(s.id !== undefined ? { id: s.id } : {}),
          ...(s.seedOverlay !== undefined ? { seedOverlay: s.seedOverlay } : {}),
        });
      }
      meta.steps = steps;

      // The harness evaluates the anchor on the FINAL step only (both the trace
      // read and the diff are the final step's). If a task pins `evaluatedStepId`
      // to some other step, that's silently unsupported — fail loud at load rather
      // than mis-scoring a non-final step.
      const evalStepId = meta.anchor?.evaluatedStepId;
      const lastStepId = steps[steps.length - 1]!.id;
      if (evalStepId !== undefined && evalStepId !== lastStepId) {
        throw new Error(
          `Task "${meta.id}": anchor.evaluatedStepId "${evalStepId}" must be the final step ("${lastStepId ?? "<unnamed>"}") — non-final anchoring is not supported.`,
        );
      }

      tasks.push({ meta, dir, prompt: steps[steps.length - 1]!.prompt });
      continue;
    }

    // Campaign task: `meta.campaign` present ⇒ resolve each link's `file`
    // (task-dir-relative) into its prompt, carrying id/anchor through, and write
    // the resolved CampaignTask[] back onto meta so runCampaign reads prompts.
    // `campaign` WINS over any redundant task.md (loader-safety) — the fixture
    // ships one deliberately, which we ignore, exactly as `steps` does. Task.prompt
    // is the FIRST link's prompt: any valid prompt suffices since each link carries
    // its own and the CLI judges every link against ITS own ask, not Task.prompt.
    const rawCampaign = (meta as { campaign?: CampaignTaskDto[] }).campaign;
    if (rawCampaign && rawCampaign.length > 0) {
      const campaign: CampaignTask[] = [];
      for (const c of rawCampaign) {
        // Validate the task-controlled `file` ref stays inside the task dir —
        // a malformed/hostile meta.json must not read arbitrary host files.
        const prompt = await fs.readFile(resolveWithin(dir, c.file), "utf8");
        campaign.push({
          prompt,
          ...(c.id !== undefined ? { id: c.id } : {}),
          ...(c.anchor !== undefined ? { anchor: c.anchor } : {}),
        });
      }
      meta.campaign = campaign;
      tasks.push({ meta, dir, prompt: campaign[0]!.prompt });
      continue;
    }

    // Single-prompt task (no steps): today's behavior — task.md is required.
    const prompt = await fs.readFile(path.join(dir, "task.md"), "utf8");
    tasks.push({ meta, dir, prompt });
  }
  return tasks;
}

// --- Arg parsing ------------------------------------------------------------

interface Args {
  list: boolean;
  all: boolean;
  variants: string[];
  taskId?: string;
  /** Raw --models tokens (comma/space-separated); resolved via parseModels. */
  modelTokens: string[];
  /** Raw --concurrency value; resolved via parseConcurrency. */
  concurrency?: string;
  /** Raw --delay-ms value; resolved via parseDelayMs. */
  delayMs?: string;
  /** --report <path>: regenerate a report from a finished run (offline). */
  reportPath?: string;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { list: false, all: false, variants: [], modelTokens: [], help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--list":
        args.list = true;
        break;
      case "--all":
        args.all = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--variant":
        args.variants.push(argv[++i] ?? "");
        break;
      case "--task":
        args.taskId = argv[++i];
        break;
      case "--models":
        args.modelTokens.push(argv[++i] ?? "");
        break;
      case "--concurrency":
      case "-c":
        args.concurrency = argv[++i];
        break;
      case "--delay-ms":
        args.delayMs = argv[++i];
        break;
      case "--report":
        args.reportPath = argv[++i];
        break;
      default:
        throw new Error(`Unknown argument: ${a}`);
    }
  }
  return args;
}

/** Upper bound on concurrent cells; absurd values are clamped to this. */
export const MAX_CONCURRENCY = 16;

/**
 * Parse the --concurrency value into a positive integer. Missing → default (1,
 * today's sequential behavior). Non-integer / < 1 → throws a clear error. Values
 * above MAX_CONCURRENCY are clamped (with a warning via `onWarn`). Pure/testable.
 */
export function parseConcurrency(
  raw: string | undefined,
  onWarn: (msg: string) => void = () => {},
  fallback = 1,
): number {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new Error(`--concurrency must be a positive integer, got "${raw}".`);
  }
  const n = Number(trimmed);
  if (n < 1) {
    throw new Error(`--concurrency must be >= 1, got ${n}.`);
  }
  if (n > MAX_CONCURRENCY) {
    onWarn(`--concurrency ${n} exceeds max; clamping to ${MAX_CONCURRENCY}.`);
    return MAX_CONCURRENCY;
  }
  return n;
}

/**
 * Parse the --delay-ms value into a non-negative integer of milliseconds to
 * pause between cells. Missing → fallback (default 0 = no pacing). Non-integer /
 * negative → throws a clear error. Pure/testable.
 */
export function parseDelayMs(raw: string | undefined, fallback = 0): number {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new Error(`--delay-ms must be a non-negative integer, got "${raw}".`);
  }
  const n = Number(trimmed);
  if (n < 0) {
    throw new Error(`--delay-ms must be >= 0, got ${n}.`);
  }
  return n;
}

/**
 * Parse executor model tokens (comma/space-separated, possibly across multiple
 * --models flags): trim, drop empties, dedup preserving order. Falls back to the
 * single default model when nothing valid is given — preserving today's
 * single-model behavior when --models is absent. Pure/unit-testable.
 */
export function parseModels(tokens: string[], fallback: string): string[] {
  const models: string[] = [];
  for (const model of tokens.join(",").split(/[\s,]+/)) {
    const trimmed = model.trim();
    if (trimmed.length > 0 && !models.includes(trimmed)) models.push(trimmed);
  }
  return models.length > 0 ? models : [fallback];
}

const USAGE = `CLAUDE.md Variant Benchmarking Harness

Usage:
  npm run bench -- --list                 List variants and tasks (no auth needed)
  npm run bench -- --all                  Run every variant against every task
  npm run bench -- --variant <name> ...   Run only the named variant(s)
  npm run bench -- --task <id>            Restrict to one task id
  npm run bench -- --models <csv>         Executor models, e.g. fable,sonnet,opus
                                          (default: ${EXECUTOR_MODEL}; judge is fixed)
  npm run bench -- --concurrency <N>      Run up to N cells in parallel
                                          (default ${DEFAULT_CONCURRENCY}, or BENCH_CONCURRENCY; heavy —
                                          watch Docker memory before raising)
  npm run bench -- --delay-ms <N>         Pause N ms between cells (default 0)
  npm run bench -- --report <path>        Regenerate report.md/json from a finished
                                          run (folder or report.json) — offline

Prereqs: build the image (npm run build-image) and authenticate once
(npm run setup-auth). See README for the isolation model.`;

// --- Orchestration ----------------------------------------------------------

function selectVariants(all: Variant[], names: string[]): Variant[] {
  if (names.length === 0) return all;
  const selected = all.filter((v) => names.includes(v.name));
  const missing = names.filter((n) => !all.some((v) => v.name === n));
  if (missing.length > 0) {
    throw new Error(`Unknown variant(s): ${missing.join(", ")}`);
  }
  return selected;
}

function selectTasks(all: Task[], taskId?: string): Task[] {
  if (!taskId) return all;
  const t = all.filter((task) => task.meta.id === taskId);
  if (t.length === 0) throw new Error(`Unknown task id: ${taskId}`);
  return t;
}

async function preflight(executorModels: string[]): Promise<void> {
  if (!hasOAuthToken()) {
    console.error(
      `No token found — run \`npm run setup-auth\` (or export ${OAUTH_TOKEN_ENV}).`,
    );
    process.exit(1);
  }

  // Probe every distinct executor model plus the fixed judge model (deduped): a
  // subscription can be entitled to one alias but not another, so checking only
  // some would let the matrix run partway before failing.
  const models = [...new Set([...executorModels, JUDGE_MODEL])];
  for (const model of models) {
    process.stderr.write(`Preflight: checking container auth for "${model}"... `);
    const { loggedIn, detail } = await checkAuth(model);
    if (!loggedIn) {
      console.error(
        `FAILED.\nThe isolated container is not logged in (model "${model}").\nDetail: ${detail}\n\nRun the one-time login: npm run setup-auth`,
      );
      process.exit(1);
    }
    process.stderr.write("ok\n");
  }
}

/** One benchmark cell: a (variant × task × executorModel) unit of work. */
interface Cell {
  executorModel: string;
  task: Task;
  variant: Variant;
}

/**
 * Run one cell: executor → judge → persist, returning the scored result. Never
 * throws — a judge failure is captured into a zero-scored result. Logging mode:
 *   - `buffered=false` (concurrency 1): stream lines live, exactly as before.
 *   - `buffered=true` (concurrency >1): collect this cell's lines and emit them
 *     as one contiguous block with a `[k/total]` progress header on completion,
 *     so concurrent cells don't interleave into noise.
 */
/**
 * Injectable seams for {@link runCell} (tests only; real deps default). Lets a
 * unit test assert the sequence-vs-single dispatch branch and the anchor
 * attachment without spawning containers or a real judge.
 */
export interface RunCellDeps {
  runVariant?: typeof runVariantTask;
  runSequence?: typeof runSequenceTask;
  judge?: typeof judgeRun;
  writeResult?: typeof writeRunResult;
  detect?: typeof detectAnchor;
}

/**
 * Read the raw NDJSON trace of the cell's FINAL step for setup-gotcha detection.
 * A sequence task tees each step to `trace-step-<n>.ndjson` (n 1-based), so the
 * final step is `trace-step-<stepCount>.ndjson`; a single-shot cell writes
 * `trace.ndjson`. A missing/unreadable trace resolves to undefined (never
 * throws) — the detector fails closed when the trace is absent.
 */
async function readFinalTrace(cellDir: string, task: Task): Promise<string | undefined> {
  const steps = task.meta.steps;
  const tracePath = steps?.length
    ? path.join(cellDir, `trace-step-${steps.length}.ndjson`)
    : path.join(cellDir, "trace.ndjson");
  return fs.readFile(tracePath, "utf8").catch(() => undefined);
}

export async function runCell(
  cell: Cell,
  buffered: boolean,
  progress: { completed: number; total: number; started: number; running: number },
  runResultsDir: string,
  deps: RunCellDeps = {},
): Promise<VariantTaskResult> {
  const runVariant = deps.runVariant ?? runVariantTask;
  const runSequence = deps.runSequence ?? runSequenceTask;
  const judge = deps.judge ?? judgeRun;
  const writeResult = deps.writeResult ?? writeRunResult;
  const detect = deps.detect ?? detectAnchor;
  const label = `${cell.variant.name} × ${cell.task.meta.id} [${cell.executorModel}]`;
  const lines: string[] = [];
  const emit = (line: string) => {
    if (buffered) lines.push(line);
    else console.error(line);
  };

  if (buffered) {
    // Live: announce the cell as it STARTS (not just on completion) with the
    // in-flight count, so concurrent containers are visible in real time.
    const s = ++progress.started;
    progress.running += 1;
    console.error(`▶ [${s}/${progress.total}] ${label} started — ${progress.running} running`);
  } else {
    console.error(`\n=== ${label} ===`);
  }

  // A task with resolved `steps` is a sequential-memory run: the same
  // accumulating workspace is driven step-by-step and we score the FINAL step's
  // artifacts. A stepless task takes today's single-shot path unchanged.
  const artifacts = cell.task.meta.steps?.length
    ? await runSequence(cell.variant, cell.task, cell.executorModel, runResultsDir)
    : await runVariant(cell.variant, cell.task, cell.executorModel, runResultsDir);
  if (!artifacts.executorOk) {
    emit(`  executor: FAILED — ${artifacts.failureReason}`);
  } else {
    emit(
      `  executor: ok (${artifacts.changedFiles.length} files, tests=${artifacts.testFilesPresent})`,
    );
  }

  const cellDir = path.join(runResultsDir, artifacts.cellId);
  // A single judge failure (container error, timeout, malformed or out-of-range
  // output) must not abort the matrix or discard prior results.
  let result: VariantTaskResult;
  try {
    result = await judge(artifacts, cell.task);
  } catch (err) {
    result = buildFailureResult(artifacts, cell.task, { judge: (err as Error).message });
    emit(`  judge: FAILED — ${result.judgeFailure}`);
  }

  // Deterministic anchor verdict (separate from the /100 score): when the task
  // declares an anchor, mechanically read the FINAL-step diff for whether it
  // held the required convention / hit the known trap, and attach it BEFORE
  // persisting so it survives to disk and renders in the report.
  //
  // GATED on executorOk: a failed OR demoted cell must NOT get an anchor. In
  // particular runSequenceTask demotes a cell to executorOk=false when a
  // non-final (establish) step failed while leaving the final diff intact — so
  // an ungated read here would score "✓ held" for a run where memory was never
  // established. Skipping keeps that cell an honest coverage gap, not a lie.
  const anchorConfig = cell.task.meta.anchor;
  if (anchorConfig && artifacts.executorOk) {
    // Only the setup-gotcha detector needs the raw NDJSON trace of the final
    // step (the runtime setup command / failure lives in tool I/O that the
    // transcript drops). Diff-based kinds (money-cents, registry) don't — so we
    // don't touch disk for them. A missing/unreadable trace stays undefined and
    // the detector already fails closed.
    const trace =
      anchorConfig.kind === "setup-gotcha"
        ? await readFinalTrace(cellDir, cell.task)
        : undefined;
    result.anchors = detect(anchorConfig, {
      diff: artifacts.diff,
      metrics: artifacts.executorMetrics,
      timedOut: artifacts.executorTimedOut,
      ...(trace !== undefined ? { trace } : {}),
    });
  }

  await writeResult(cellDir, result);
  emit(`  judged: total ${result.total}/100  ${formatExecLine(result.metrics.executor)}`);

  if (buffered) {
    const k = ++progress.completed;
    progress.running -= 1;
    const header = `[${k}/${progress.total}] ${label} — ${progress.running} still running`;
    console.error(`\n${header}\n${lines.join("\n")}`);
  }
  return result;
}

/**
 * Injectable seams for {@link runCampaignCell} (tests only; real deps default).
 * Lets a unit test drive the per-link judge + anchor + assemble logic with a fake
 * chain runner, so no containers, no real judge, and no fs are touched.
 */
export interface RunCampaignDeps {
  campaign?: typeof runCampaign;
  judge?: typeof judgeRun;
  detect?: typeof detectAnchor;
}

/**
 * Run ONE campaign cell: drive the whole `runCampaign` chain in a single
 * persistent workspace, then judge AND anchor EACH link independently, assembling
 * the ordered per-link {@link CampaignTaskResult}s into one {@link CampaignResult}.
 *
 * Unlike {@link runCell} (one scored task) a campaign scores every link against
 * ITS OWN ask: the judge sees `{ ...task, prompt: <that link's prompt> }` so the
 * /100 reflects the link, not the chain. The deterministic anchor is computed only
 * when the link declares one AND its executor succeeded — GATED on `executorOk`
 * exactly like {@link runCell}, so a failed/empty-diff link never scores "held".
 * Campaign anchors are `rule`-kind (diff-based), so no NDJSON trace is threaded.
 *
 * Never throws: a judge failure on ONE link is captured into that link's `failure`
 * and the chain continues — one bad link must not abort the campaign or the matrix.
 */
export async function runCampaignCell(
  cell: Cell,
  runResultsDir: string,
  deps: RunCampaignDeps = {},
): Promise<CampaignResult> {
  const runChain = deps.campaign ?? runCampaign;
  const judge = deps.judge ?? judgeRun;
  const detect = deps.detect ?? detectAnchor;
  const label = `${cell.variant.name} × ${cell.task.meta.id} [${cell.executorModel}]`;
  console.error(`\n=== campaign ${label} ===`);

  const links = await runChain(cell.variant, cell.task, cell.executorModel, runResultsDir);
  const campaignLinks = cell.task.meta.campaign ?? [];

  const tasks: CampaignTaskResult[] = [];
  for (const link of links) {
    // The runner returns artifacts + identity per link, in chain order; the link's
    // prompt and anchor live on the resolved campaign meta at the same index.
    const linkMeta = campaignLinks[link.index];
    const linkTask: Task = { ...cell.task, prompt: linkMeta?.prompt ?? cell.task.prompt };

    // A single judge failure (container error, timeout, malformed output) must not
    // abort the campaign — capture it into an all-zero failure result and proceed.
    let result: VariantTaskResult;
    try {
      result = await judge(link.artifacts, linkTask);
    } catch (err) {
      result = buildFailureResult(link.artifacts, linkTask, { judge: (err as Error).message });
    }

    // Deterministic anchor verdict, GATED on executorOk (a failed link's empty
    // diff must not read as "held"). Skip entirely when the link has no anchor.
    const anchorConfig = linkMeta?.anchor;
    if (anchorConfig && link.artifacts.executorOk) {
      // Anchor against the CUMULATIVE campaign diff (chain base → this link) when
      // available, so a convention encoded in an earlier link's helper and reused
      // here still counts as held; fall back to the per-link diff (`||`, so an empty
      // cumulative diff falls back too). The judge still scores the per-link
      // `artifacts.diff` — only the deterministic anchor widens its view.
      //
      // Semantic: a `required` marker holds if the convention PERSISTS anywhere in
      // the chain's cumulative work — not that THIS link re-touched it. That is the
      // intended "convention stays consistent across the chain" reading; the cost is
      // that a required-only anchor can't flag a later link that does new
      // convention-relevant work the wrong way. Campaign `rule` anchors therefore
      // pair every `required` with a `forbidden` complement (the known-wrong form),
      // which is ALSO evaluated cumulatively and fires on an active violation.
      result.anchors = detect(anchorConfig, {
        diff: link.cumulativeDiff || link.artifacts.diff,
        metrics: link.artifacts.executorMetrics,
        timedOut: link.artifacts.executorTimedOut,
      });
    }

    // A link is scored iff neither the executor nor the judge failed; otherwise the
    // link carries `failure` and no score (never a fabricated 0). The anchor verdict
    // is independent of the score, so it survives a judge failure.
    const failure = result.executorFailure ?? result.judgeFailure;
    const taskResult: CampaignTaskResult = {
      taskId: link.campaignTaskId,
      index: link.index,
      metrics: link.artifacts.executorMetrics,
      ...(failure === undefined ? { score: result.total } : { failure }),
      ...(result.anchors ? { anchors: result.anchors } : {}),
    };
    tasks.push(taskResult);

    const anchorNote = result.anchors
      ? `, anchor ${result.anchors.conventionHeld ? "held" : "broken"}`
      : "";
    console.error(
      `  task ${link.index + 1}/${links.length} (${link.campaignTaskId}): ` +
        (failure ? `FAILED — ${failure}` : `score ${result.total}/100${anchorNote}`),
    );
  }

  return {
    variant: cell.variant.name,
    executorModel: cell.executorModel,
    campaignId: cell.task.meta.id,
    tasks,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(USAGE);
    return;
  }

  // Offline: regenerate a finished run's report with the current aggregation.
  // No containers, no auth, no executor/judge calls.
  if (args.reportPath) {
    const { jsonPath, mdPath } = await regenerateReport(args.reportPath);
    console.error(`Report regenerated:\n  ${mdPath}\n  ${jsonPath}`);
    return;
  }

  const [variants, tasks] = await Promise.all([loadVariants(), loadTasks()]);

  if (args.list) {
    console.log("Variants:");
    for (const v of variants) console.log(formatVariantListLine(v));
    console.log("\nTasks:");
    for (const t of tasks) {
      console.log(
        `  - ${t.meta.id}: ${t.meta.title} (logicBearing=${t.meta.logicBearing}, securityRelevant=${t.meta.securityRelevant})`,
      );
    }
    return;
  }

  if (!args.all && args.variants.length === 0 && !args.taskId) {
    console.log(USAGE);
    process.exit(2);
  }

  const selectedVariants = selectVariants(variants, args.variants);
  const selectedTasks = selectTasks(tasks, args.taskId);
  const executorModels = parseModels(args.modelTokens, EXECUTOR_MODEL);
  const concurrency = parseConcurrency(
    args.concurrency,
    (m) => console.error(`Warning: ${m}`),
    DEFAULT_CONCURRENCY,
  );
  const delayMs = parseDelayMs(args.delayMs, INTER_CELL_DELAY_MS);

  await preflight(executorModels);

  // Durable, never-overwritten output: each execution gets a GUID + its own
  // reverse-time-sorted folder holding the report AND every cell's results.
  const runId = randomUUID();
  const startedAt = new Date();
  const runDir = path.join(REPORTS_DIR, buildRunFolderName(runId, startedAt.getTime()));
  const runResultsDir = path.join(runDir, "results");
  await fs.mkdir(runResultsDir, { recursive: true });

  const report: Report = {
    runId,
    generatedAt: startedAt.toISOString(),
    taskId: selectedTasks.map((t) => t.meta.id).join(","),
    taskTitle: selectedTasks.map((t) => t.meta.title).join(", "),
    executorModels,
    judgeModel: JUDGE_MODEL,
    results: [],
  };

  // The matrix is a flat set of cells in executorModel → task → variant order.
  // The judge model is held FIXED so scores stay comparable across executor
  // models. Each cell is resource-heavy and spends quota. Campaign tasks route to
  // a SEPARATE lane: each (variant × campaign × model) runs the whole chain in one
  // persistent workspace and assembles a CampaignResult, not a per-cell score.
  const cells: Cell[] = [];
  const campaignCells: Cell[] = [];
  for (const executorModel of executorModels) {
    for (const task of selectedTasks) {
      for (const variant of selectedVariants) {
        const cell: Cell = { executorModel, task, variant };
        if (task.meta.campaign?.length) campaignCells.push(cell);
        else cells.push(cell);
      }
    }
  }

  const progress = { completed: 0, total: cells.length, started: 0, running: 0 };
  let results: VariantTaskResult[];

  // Stream live (per-line, unbuffered) only when there is no real parallelism —
  // a single cell, or concurrency 1. Otherwise buffer each cell's block so
  // concurrent output doesn't interleave, and surface start/running lines so the
  // parallelism is visible (a cell mid-flight would otherwise print nothing).
  const parallel = concurrency > 1 && cells.length > 1;
  if (!parallel) {
    results = [];
    for (let i = 0; i < cells.length; i++) {
      if (i > 0 && delayMs > 0) await sleep(delayMs);
      results.push(await runCell(cells[i]!, false, progress, runResultsDir));
    }
  } else {
    // Bounded parallelism: buffer each cell's log block so lines don't interleave.
    console.error(
      `Running ${cells.length} cells, concurrency=${concurrency} (up to ${Math.min(concurrency, cells.length)} containers at once) …`,
    );
    const outcomes = await runPool(
      cells,
      concurrency,
      (cell) => runCell(cell, true, progress, runResultsDir),
      { delayMs },
    );
    results = [];
    outcomes.forEach((o, i) => {
      // runCell captures judge failures into a result and never throws, but stay
      // robust: a genuinely thrown cell is reported and skipped, not fatal.
      if (o.value) results.push(o.value);
      else console.error(`Cell ${i} failed unexpectedly: ${o.error?.message}`);
    });
  }

  // Stable ordering regardless of concurrency (harmless at N=1): executor model
  // (as given) → variant (as given) → task id.
  const modelIndex = new Map(executorModels.map((m, i) => [m, i]));
  const variantIndex = new Map(selectedVariants.map((v, i) => [v.name, i]));
  results.sort(
    (a, b) =>
      (modelIndex.get(a.executorModel) ?? 0) - (modelIndex.get(b.executorModel) ?? 0) ||
      (variantIndex.get(a.variant) ?? 0) - (variantIndex.get(b.variant) ?? 0) ||
      a.taskId.localeCompare(b.taskId),
  );
  report.results = results;

  // Campaign lane: each chain runs sequentially in its own persistent workspace
  // (memory must accumulate across links, so no cross-campaign parallelism here).
  // One failed link never aborts the campaign or the run — runCampaignCell absorbs
  // it into that link's result.
  if (campaignCells.length > 0) {
    const campaigns: CampaignResult[] = [];
    for (const cell of campaignCells) {
      // Absorb a thrown campaign cell exactly like the pooled lane does: a
      // prepare/git/fs throw must not propagate past here and discard the
      // already-computed, quota-expensive report.results before writeReport runs.
      try {
        campaigns.push(await runCampaignCell(cell, runResultsDir));
      } catch (err) {
        console.error(
          `Campaign cell ${cell.variant.name} × ${cell.task.meta.id} failed unexpectedly: ${(err as Error).message}`,
        );
      }
    }
    report.campaigns = campaigns;
  }

  const { jsonPath, mdPath } = await writeReport(report, runDir);
  console.error(`\nReport written:\n  ${mdPath}\n  ${jsonPath}`);
}

/** True when this module is the process entry point (not imported by a test). */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isMainModule()) {
  main().catch((err) => {
    console.error(`\nFatal: ${(err as Error).message}`);
    process.exit(1);
  });
}
