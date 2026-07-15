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
  PAIRWISE_ENABLED,
  PROMPTS_DIR,
  REPEATS,
  REPORTS_DIR,
  TASKS_DIR,
} from "./config.js";
import { hasOAuthToken } from "./auth.js";
import { checkAuth } from "./docker.js";
import { formatExecLine } from "./metrics.js";
import { runPool } from "./pool.js";
import { sleep } from "./retry.js";
import { runCampaign, runSequenceTask, runVariantTask } from "./executor.js";
import { detectAnchorGraded } from "./anchors.js";
import { judgeCell, writeRunResult } from "./judge.js";
import type { JudgeCellOutcome } from "./judge.js";
import { judgePair } from "./pairwise.js";
import type { JudgePairInputs } from "./pairwise.js";
import { aggregatePairwise, regenerateReport, writeReport, FOCUS_AXES } from "./report.js";
import type { FocusAxis } from "./report.js";
import type { CellJudgePromptInputs } from "./rubric.js";
import { addedLines, computeSlopMetrics } from "./slop.js";
import { expectedSurfaceFor, filesOutsideExpectedSurface } from "./surface.js";
import { buildRunFolderName } from "./runmeta.js";
import { parseVariantManifest } from "./variant.js";
import { resolveWithin } from "./workspace.js";
import type {
  AnchorConfig,
  AnchorResult,
  CampaignResult,
  CampaignTask,
  CampaignTaskResult,
  CellJudgeResult,
  CraftScore,
  PairwiseResult,
  Report,
  RuleAnchor,
  Task,
  TaskMeta,
  TaskStep,
  TestResults,
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
    // step's prompt: the judge scores the final step and receives task.prompt
    // as its task context, so it must see the final step's ask.
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
  /** Raw --repeats value; resolved via parseRepeats. */
  repeats?: string;
  /** --no-pairwise: skip the pairwise A/B craft lane for this run. */
  noPairwise: boolean;
  /** --report <path>: regenerate a report from a finished run (offline). */
  reportPath?: string;
  /** --focus <axis>: render only the named axis's section(s) + run header. */
  focus?: FocusAxis;
  help: boolean;
}

/**
 * Validate a raw --focus token against the accepted axes. Throws a clear,
 * enumerated error on an unknown value so a typo fails fast instead of silently
 * rendering the full report. Pure/testable.
 */
export function parseFocus(raw: string | undefined): FocusAxis | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if ((FOCUS_AXES as readonly string[]).includes(trimmed)) {
    return trimmed as FocusAxis;
  }
  throw new Error(
    `--focus must be one of: ${FOCUS_AXES.join(", ")}; got "${raw}".`,
  );
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    list: false,
    all: false,
    variants: [],
    modelTokens: [],
    noPairwise: false,
    help: false,
  };
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
      case "--repeats":
        args.repeats = argv[++i];
        break;
      case "--no-pairwise":
        args.noPairwise = true;
        break;
      case "--report":
        args.reportPath = argv[++i];
        break;
      case "--focus":
        args.focus = parseFocus(argv[++i]);
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
 * Parse the --repeats value into a positive integer of runs per cell. Missing →
 * fallback (config.REPEATS, default 1 = today's single-run behavior).
 * Non-integer / < 1 → throws a clear error. Pure/testable.
 */
export function parseRepeats(raw: string | undefined, fallback = REPEATS): number {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new Error(`--repeats must be a positive integer, got "${raw}".`);
  }
  const n = Number(trimmed);
  if (n < 1) {
    throw new Error(`--repeats must be >= 1, got ${n}.`);
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
  npm run bench -- --repeats <N>          Run each cell N times (default ${REPEATS});
                                          repeated cells get distinct __rN cell ids
  npm run bench -- --no-pairwise          Skip the pairwise A/B craft lane
                                          (also BENCH_PAIRWISE=0)
  npm run bench -- --report <path>        Regenerate report.md/json from a finished
                                          run (folder or report.json) — offline
  npm run bench -- --focus <axis>         Render only one concern's section(s) + the
                                          run header. axis ∈ correctness | memory |
                                          craft | efficiency | blast-radius

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
  // Implicit roster (`--all`): drop `testOnly` fixtures — synthetic tasks whose
  // stub prompt yields an empty diff on a real run and only exist to feed the
  // fake-executor integration tests. An explicit `--task <id>` still selects one.
  if (!taskId) return all.filter((task) => !task.meta.testOnly);
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

/** One benchmark cell: a (variant × task × executorModel[× repeat]) unit of work. */
export interface Cell {
  executorModel: string;
  task: Task;
  variant: Variant;
  /** 1-based repeat index; set only when the run's repeats > 1 (see buildCells). */
  repeat?: number;
}

/**
 * Identity of one collected diff — the grouping key for pairwise comparisons.
 * `linkIndex` is set only for campaign links (a campaign's `taskId` is its
 * campaignId, so link N of chain X never pairs with link M or a single cell).
 */
export interface CellDiffKey {
  taskId: string;
  variant: string;
  executorModel: string;
  repeat?: number;
  linkIndex?: number;
}

/** Pair-relevant context captured alongside a cell's diff. */
export interface CellDiffContext {
  /** Pre-rendered deterministic anchor verdict (the grade, or "none"). */
  anchor: string;
  /** Pre-rendered deterministic test outcome (formatTestResultsSummary). */
  tests: string;
  /** The prompt this cell's executor was given (a link's own ask in campaigns). */
  taskPrompt: string;
  /** True when the cell was hard-disqualified (adversarial blast radius). */
  disqualified: boolean;
  /** True when the executor succeeded — failed cells never enter a pair. */
  ok: boolean;
}

/** Seam invoked once per cell / per campaign link with its diff + context. */
export type CellDiffCollector = (
  key: CellDiffKey,
  diff: string,
  context: CellDiffContext,
) => void;

/** One collected (key, diff, context) record — the pairwise lane's input. */
export interface CollectedDiff {
  key: CellDiffKey;
  diff: string;
  context: CellDiffContext;
}

/**
 * Render the deterministic test outcome for the judge/pairwise context:
 * "none" when the task declared no testCommand (the ONLY value that arms the
 * judge's correctness fallback), else "pass"/"fail" with best-effort counts
 * appended when both were parsed (e.g. `pass (3p/0f)`).
 */
export function formatTestResultsSummary(testResults: TestResults | undefined): string {
  if (testResults === undefined) return "none";
  const verdict = testResults.ok ? "pass" : "fail";
  return testResults.passed !== undefined && testResults.failed !== undefined
    ? `${verdict} (${testResults.passed}p/${testResults.failed}f)`
    : verdict;
}

/** `N/S/C/E` craft scores for a console line; `?` for unknown/missing. */
function formatCraftLine(judge: CellJudgeResult | undefined): string {
  const s = (v: CraftScore | undefined): string =>
    v === undefined || v.score === "unknown" ? "?" : String(v.score);
  const c = judge?.craft;
  return `${s(c?.naming)}/${s(c?.structure)}/${s(c?.consistency)}/${s(c?.economy)}`;
}

/** The fail-closed empty verdict used when the judge seam THROWS (see judgeSafe). */
function emptyCellVerdict(flag: string): CellJudgeResult {
  const unknown = (): CraftScore => ({ score: "unknown", evidence: [] });
  return {
    craft: { naming: unknown(), structure: unknown(), consistency: unknown(), economy: unknown() },
    blastRadius: [],
    correctnessAssessment: null,
    flags: [flag],
  };
}

/**
 * Call the cell judge, absorbing a THROW into a fail-closed outcome. judgeCell
 * never throws by contract, but this seam is injectable — one bad judge
 * invocation must never abort the matrix, so guard it anyway.
 */
async function judgeSafe(
  judge: typeof judgeCell,
  inputs: CellJudgePromptInputs,
): Promise<JudgeCellOutcome> {
  try {
    return await judge(inputs);
  } catch (err) {
    return {
      result: emptyCellVerdict("judge-threw"),
      judgeFailure: (err as Error).message,
      evidenceTruncated: false,
    };
  }
}

/**
 * Run one cell: executor → deterministic axes (anchor, slop, surface) →
 * structured cell judge → persist, returning the assembled result. Never
 * throws — a judge failure degrades to a fail-closed verdict with
 * `judgeFailure` set (the cell is then excluded from aggregation). Logging
 * mode:
 *   - `buffered=false` (concurrency 1): stream lines live, exactly as before.
 *   - `buffered=true` (concurrency >1): collect this cell's lines and emit them
 *     as one contiguous block with a `[k/total]` progress header on completion,
 *     so concurrent cells don't interleave into noise.
 */
/**
 * Injectable seams for {@link runCell} (tests only; real deps default). Lets a
 * unit test assert the sequence-vs-single dispatch branch, the anchor
 * attachment, and the judge-input threading without spawning containers or a
 * real judge. `onDiff` is the pairwise lane's collector — main() registers one
 * to gather every cell's diff in memory while the matrix runs.
 */
export interface RunCellDeps {
  runVariant?: typeof runVariantTask;
  runSequence?: typeof runSequenceTask;
  judge?: typeof judgeCell;
  writeResult?: typeof writeRunResult;
  detect?: typeof detectAnchorGraded;
  onDiff?: CellDiffCollector;
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
  const judge = deps.judge ?? judgeCell;
  const writeResult = deps.writeResult ?? writeRunResult;
  const detect = deps.detect ?? detectAnchorGraded;
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
  // `cell.repeat` threads through to prepareWorkspace so a repeated cell gets a
  // distinct `__rN` cellId (undefined ⇒ today's ids, byte-identical).
  const artifacts = cell.task.meta.steps?.length
    ? await runSequence(cell.variant, cell.task, cell.executorModel, runResultsDir, undefined, cell.repeat)
    : await runVariant(cell.variant, cell.task, cell.executorModel, runResultsDir, undefined, cell.repeat);
  if (!artifacts.executorOk) {
    emit(`  executor: FAILED — ${artifacts.failureReason}`);
  } else {
    // Report the DETERMINISTIC test verdict, not `testFilesPresent` (which only
    // means "the diff touched a test file"). Printing presence-as-a-boolean here
    // read like "tests ran/passed" and masked an empty Correctness column for a
    // whole matrix (issue #9). `none` = no testCommand ran for this cell.
    emit(
      `  executor: ok (${artifacts.changedFiles.length} files, tests: ${formatTestResultsSummary(artifacts.testResults)})`,
    );
  }

  const cellDir = path.join(runResultsDir, artifacts.cellId);

  // ANCHOR FIRST — the graded verdict is a judge INPUT now, so it must exist
  // before the judge call. GATED on executorOk: a failed OR demoted cell must
  // NOT get an anchor. In particular runSequenceTask demotes a cell to
  // executorOk=false when a non-final (establish) step failed while leaving the
  // final diff intact — an ungated read here would score "held" for a run where
  // memory was never established. Skipping keeps that cell an honest coverage
  // gap, not a lie.
  let anchors: AnchorResult | undefined;
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
    anchors = detect(
      anchorConfig,
      {
        diff: artifacts.diff,
        metrics: artifacts.executorMetrics,
        timedOut: artifacts.executorTimedOut,
        ...(trace !== undefined ? { trace } : {}),
      },
      // Single/sequence cells have no chain, so no cumulative diff.
      { linkDiff: artifacts.diff },
    );
  }

  // Deterministic axes, computed by the harness and handed to the judge
  // read-only — it never gets to re-derive or dispute them.
  const slop = computeSlopMetrics({ diff: artifacts.diff });
  const surface = expectedSurfaceFor(cell.task.meta);
  const outOfScope = filesOutsideExpectedSurface(
    artifacts.changedFiles.map((f) => f.path),
    surface,
  );
  const testsSummary = formatTestResultsSummary(artifacts.testResults);

  const common = {
    cellId: artifacts.cellId,
    variant: artifacts.variant,
    taskId: artifacts.taskId,
    executorModel: artifacts.executorModel,
    judgeModel: JUDGE_MODEL,
    ...(cell.repeat !== undefined ? { repeat: cell.repeat } : {}),
    ...(artifacts.behavior ? { behavior: artifacts.behavior } : {}),
  };

  let result: VariantTaskResult;
  if (!artifacts.executorOk) {
    // Executor-failure assembly: the result carries executorFailure and no
    // judge verdict — no judge quota is spent, the cell derives scored=false at
    // report time, and none of the five-axis fields are attached (a zero-slop
    // reading on an empty diff would masquerade as "measured clean").
    result = {
      ...common,
      metrics: { executor: artifacts.executorMetrics },
      executorFailure: artifacts.failureReason ?? "unknown error",
    };
  } else {
    const outcome = await judgeSafe(judge, {
      taskPrompt: cell.task.prompt,
      conventionsList: "none",
      anchorVerdict: anchors?.grade ?? "none",
      testResultsSummary: testsSummary,
      slopMetricsJson: JSON.stringify(slop),
      outOfScopeFiles: outOfScope,
      diff: artifacts.diff,
    });
    if (outcome.judgeFailure) emit(`  judge: FAILED — ${outcome.judgeFailure}`);
    // Any adversarial blast-radius entry hard-disqualifies the cell — it is
    // excluded from craft aggregation, never scored low.
    const disqualified =
      outcome.result.blastRadius.some((b) => b.classification === "adversarial") ||
      undefined;
    result = {
      ...common,
      judge: outcome.result,
      slop,
      ...(artifacts.testResults !== undefined ? { testResults: artifacts.testResults } : {}),
      ...(surface !== undefined ? { filesOutsideExpectedSurface: outOfScope } : {}),
      ...(anchors ? { anchors } : {}),
      ...(disqualified ? { disqualified } : {}),
      metrics: {
        executor: artifacts.executorMetrics,
        ...(outcome.metrics ? { judge: outcome.metrics } : {}),
      },
      ...(outcome.judgeFailure ? { judgeFailure: outcome.judgeFailure } : {}),
      ...(outcome.evidenceTruncated ? { evidenceTruncated: true } : {}),
    };
  }

  // Feed the pairwise lane's in-memory registry (main() groups + pairs later).
  // Invoked for EVERY cell — failed/disqualified ones carry the flags that make
  // buildPairJobs exclude them, so eligibility is decided in one place.
  deps.onDiff?.(
    {
      taskId: cell.task.meta.id,
      variant: cell.variant.name,
      executorModel: cell.executorModel,
      ...(cell.repeat !== undefined ? { repeat: cell.repeat } : {}),
    },
    artifacts.diff,
    {
      anchor: anchors?.grade ?? "none",
      tests: testsSummary,
      taskPrompt: cell.task.prompt,
      disqualified: result.disqualified === true,
      ok: artifacts.executorOk,
    },
  );

  await writeResult(cellDir, result);
  emit(
    `  judged: craft N/S/C/E=${formatCraftLine(result.judge)} anchor=${result.anchors?.grade ?? "—"}  ${formatExecLine(result.metrics.executor)}`,
  );

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
  judge?: typeof judgeCell;
  detect?: typeof detectAnchorGraded;
  onDiff?: CellDiffCollector;
}

/**
 * Run ONE campaign cell: drive the whole `runCampaign` chain in a single
 * persistent workspace, then judge AND anchor EACH link independently, assembling
 * the ordered per-link {@link CampaignTaskResult}s into one {@link CampaignResult}.
 *
 * Unlike {@link runCell} (one scored task) a campaign judges every link against
 * ITS OWN ask (the link's prompt) and its OWN per-link diff — the judge NEVER
 * sees the cumulative chain diff. The deterministic anchor is computed only when
 * the link declares one AND its executor succeeded — GATED on `executorOk`
 * exactly like {@link runCell}, so a failed/empty-diff link never scores "held".
 * Campaign anchors are `rule`-kind (diff-based), so no NDJSON trace is threaded;
 * the graded detector receives the link diff PLUS the cumulative chain diff so a
 * convention held via a helper built at an earlier link grades
 * `held-by-abstraction` (the fd9239c false-negative fix) instead of drifting.
 *
 * Chain context threaded across links:
 * - `earlierAdded` accumulates each successful link's added lines so a later
 *   link's slop metrics can measure churn against the chain's own prior work.
 * - `conventionsList` hands the judge the labels of every rule anchor declared
 *   on links up to (and including) the current one — the standing conventions
 *   the chain is expected to keep.
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
  const judge = deps.judge ?? judgeCell;
  const detect = deps.detect ?? detectAnchorGraded;
  const label = `${cell.variant.name} × ${cell.task.meta.id} [${cell.executorModel}]`;
  console.error(`\n=== campaign ${label} ===`);

  const links = await runChain(
    cell.variant,
    cell.task,
    cell.executorModel,
    runResultsDir,
    undefined,
    cell.repeat,
  );
  const campaignLinks = cell.task.meta.campaign ?? [];

  const tasks: CampaignTaskResult[] = [];
  // Added lines of every SUCCESSFUL earlier link, in chain order — the churn
  // baseline for later links' slop metrics. Failed links contribute nothing
  // (their diff is not the chain's established work).
  const earlierAdded: string[] = [];
  for (const link of links) {
    // The runner returns artifacts + identity per link, in chain order; the link's
    // prompt and anchor live on the resolved campaign meta at the same index.
    const linkMeta = campaignLinks[link.index];
    const linkPrompt = linkMeta?.prompt ?? cell.task.prompt;

    // ANCHOR FIRST (judge input), GATED on executorOk (a failed link's empty
    // diff must not read as "held"). Skip entirely when the link has no anchor.
    // The graded detector judges the LINK diff with the CUMULATIVE chain diff as
    // fallback context: a convention re-emitted literally grades held-by-literal;
    // one held only via an earlier link's helper grades held-by-abstraction.
    let anchors: AnchorResult | undefined;
    const anchorConfig = linkMeta?.anchor;
    if (anchorConfig && link.artifacts.executorOk) {
      anchors = detect(
        anchorConfig,
        {
          diff: link.artifacts.diff,
          metrics: link.artifacts.executorMetrics,
          timedOut: link.artifacts.executorTimedOut,
        },
        {
          linkDiff: link.artifacts.diff,
          ...(link.cumulativeDiff !== undefined ? { cumulativeDiff: link.cumulativeDiff } : {}),
        },
      );
    }

    // Slop for THIS link, measured against the chain's EARLIER work — then (and
    // only then, and only for a successful link) fold this link's added lines
    // into the baseline. Order is load-bearing: a link must never churn against
    // its own additions.
    const slop = computeSlopMetrics({
      diff: link.artifacts.diff,
      ...(earlierAdded.length ? { earlierAddedLines: earlierAdded } : {}),
    });
    if (link.artifacts.executorOk) earlierAdded.push(...addedLines(link.artifacts.diff));

    const surface = expectedSurfaceFor(cell.task.meta, linkMeta);
    const outOfScope = filesOutsideExpectedSurface(
      link.artifacts.changedFiles.map((f) => f.path),
      surface,
    );
    const testsSummary = formatTestResultsSummary(link.testResults);

    // Standing conventions: the human-readable labels of every rule anchor
    // declared on links up to (and including) this one — later links are the
    // chain's future, not its standing rules.
    const conventionLabels = campaignLinks
      .slice(0, link.index + 1)
      .map((l) => l.anchor)
      .filter((a): a is RuleAnchor => a?.kind === "rule" && a.label !== undefined)
      .map((a) => `- ${a.label}`);
    const conventionsList = conventionLabels.length > 0 ? conventionLabels.join("\n") : "none";

    // A link is scored iff neither the executor nor the judge failed; otherwise
    // the link carries `failure` (never a fabricated verdict). The anchor is
    // independent of the judge, so it survives a judge failure.
    let taskResult: CampaignTaskResult;
    let failure: string | undefined;
    let judgeVerdict: CellJudgeResult | undefined;
    if (!link.artifacts.executorOk) {
      failure = link.artifacts.failureReason ?? "unknown error";
      taskResult = {
        taskId: link.campaignTaskId,
        index: link.index,
        metrics: link.artifacts.executorMetrics,
        failure,
      };
    } else {
      // The judge scores the PER-LINK diff (never cumulative) against the link's
      // own ask. A judge failure fail-closes into an empty verdict + `failure`;
      // the chain continues.
      const outcome = await judgeSafe(judge, {
        taskPrompt: linkPrompt,
        conventionsList,
        anchorVerdict: anchors?.grade ?? "none",
        testResultsSummary: testsSummary,
        slopMetricsJson: JSON.stringify(slop),
        outOfScopeFiles: outOfScope,
        diff: link.artifacts.diff,
      });
      judgeVerdict = outcome.result;
      failure = outcome.judgeFailure;
      const disqualified = outcome.result.blastRadius.some(
        (b) => b.classification === "adversarial",
      );
      taskResult = {
        taskId: link.campaignTaskId,
        index: link.index,
        metrics: link.artifacts.executorMetrics,
        judge: outcome.result,
        slop,
        ...(link.testResults !== undefined ? { testResults: link.testResults } : {}),
        ...(surface !== undefined ? { filesOutsideExpectedSurface: outOfScope } : {}),
        ...(disqualified ? { disqualified: true } : {}),
        ...(anchors ? { anchors } : {}),
        ...(failure !== undefined ? { failure } : {}),
      };
    }
    tasks.push(taskResult);

    // Feed the pairwise lane: campaign links pair by (campaignId, linkIndex).
    deps.onDiff?.(
      {
        taskId: cell.task.meta.id,
        variant: cell.variant.name,
        executorModel: cell.executorModel,
        ...(cell.repeat !== undefined ? { repeat: cell.repeat } : {}),
        linkIndex: link.index,
      },
      link.artifacts.diff,
      {
        anchor: anchors?.grade ?? "none",
        tests: testsSummary,
        taskPrompt: linkPrompt,
        disqualified: taskResult.disqualified === true,
        ok: link.artifacts.executorOk,
      },
    );

    console.error(
      `  task ${link.index + 1}/${links.length} (${link.campaignTaskId}): ` +
        (failure
          ? `FAILED — ${failure}`
          : `craft N/S/C/E=${formatCraftLine(judgeVerdict)} anchor=${anchors?.grade ?? "—"}`),
    );
  }

  return {
    variant: cell.variant.name,
    executorModel: cell.executorModel,
    campaignId: cell.task.meta.id,
    ...(cell.repeat !== undefined ? { repeat: cell.repeat } : {}),
    tasks,
  };
}

/**
 * Build the flat cell matrix in executorModel → task → variant → repeat order,
 * routing campaign tasks to their own lane. When `repeats` is 1 the cells carry
 * NO `repeat` field (today's behavior byte-identical: unchanged cellIds, dirs,
 * report keys); when > 1 every cell of BOTH lanes fans out into one cell per
 * repeat with `repeat` set 1..N.
 */
export function buildCells(
  executorModels: string[],
  tasks: Task[],
  variants: Variant[],
  repeats: number,
): { cells: Cell[]; campaignCells: Cell[] } {
  const cells: Cell[] = [];
  const campaignCells: Cell[] = [];
  for (const executorModel of executorModels) {
    for (const task of tasks) {
      for (const variant of variants) {
        for (let r = 1; r <= repeats; r++) {
          const cell: Cell = {
            executorModel,
            task,
            variant,
            ...(repeats > 1 ? { repeat: r } : {}),
          };
          if (task.meta.campaign?.length) campaignCells.push(cell);
          else cells.push(cell);
        }
      }
    }
  }
  return { cells, campaignCells };
}

/**
 * Stable result ordering regardless of concurrency (harmless at N=1): executor
 * model (as given) → variant (as given) → task id → repeat (single runs carry
 * no repeat, so the tiebreaker is inert for them).
 */
export function resultSortComparator(
  executorModels: string[],
  variantNames: string[],
): (a: VariantTaskResult, b: VariantTaskResult) => number {
  const modelIndex = new Map(executorModels.map((m, i) => [m, i]));
  const variantIndex = new Map(variantNames.map((v, i) => [v, i]));
  return (a, b) =>
    (modelIndex.get(a.executorModel) ?? 0) - (modelIndex.get(b.executorModel) ?? 0) ||
    (variantIndex.get(a.variant) ?? 0) - (variantIndex.get(b.variant) ?? 0) ||
    a.taskId.localeCompare(b.taskId) ||
    (a.repeat ?? 0) - (b.repeat ?? 0);
}

/**
 * Pair up collected diffs for the pairwise craft lane. Groups by
 * (taskId[+linkIndex], executorModel, repeat) — comparisons never cross tasks,
 * chain links, models, or repeats — then emits one job per unordered variant
 * pair whose BOTH sides are eligible: executor ok, not disqualified, and a
 * non-empty diff (two "(no changes)" sides have nothing to compare; judgePair
 * itself randomizes the A/B presentation). Pure/testable; first-seen order.
 */
export function buildPairJobs(records: CollectedDiff[]): JudgePairInputs[] {
  const order: string[] = [];
  const groups = new Map<string, CollectedDiff[]>();
  for (const rec of records) {
    const key = [
      rec.key.taskId,
      rec.key.linkIndex ?? "",
      rec.key.executorModel,
      rec.key.repeat ?? "",
    ].join("\u0000");
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)!.push(rec);
  }

  const jobs: JudgePairInputs[] = [];
  for (const key of order) {
    const eligible = groups
      .get(key)!
      .filter((m) => m.context.ok && !m.context.disqualified && m.diff !== "");
    for (let i = 0; i < eligible.length; i++) {
      for (let j = i + 1; j < eligible.length; j++) {
        const first = eligible[i]!;
        const second = eligible[j]!;
        jobs.push({
          taskId: first.key.taskId,
          ...(first.key.linkIndex !== undefined ? { linkIndex: first.key.linkIndex } : {}),
          executorModel: first.key.executorModel,
          ...(first.key.repeat !== undefined ? { repeat: first.key.repeat } : {}),
          taskPrompt: first.context.taskPrompt,
          first: {
            variant: first.key.variant,
            diff: first.diff,
            anchor: first.context.anchor,
            tests: first.context.tests,
          },
          second: {
            variant: second.key.variant,
            diff: second.diff,
            anchor: second.context.anchor,
            tests: second.context.tests,
          },
        });
      }
    }
  }
  return jobs;
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
    const { jsonPath, mdPath } = await regenerateReport(args.reportPath, args.focus);
    console.error(`Report regenerated:\n  ${mdPath}\n  ${jsonPath}`);
    return;
  }

  const [variants, tasks] = await Promise.all([loadVariants(), loadTasks()]);

  if (args.list) {
    console.log("Variants:");
    for (const v of variants) console.log(formatVariantListLine(v));
    console.log("\nTasks:");
    for (const t of tasks) {
      // Mark testOnly fixtures: they load for the integration tests and remain
      // selectable via an explicit --task, but are skipped by the --all roster
      // (their stub prompt yields an empty diff on a real run). Flag them so an
      // operator scanning --list doesn't pick one and burn quota for no signal.
      const testOnly = t.meta.testOnly ? " (testOnly — excluded from --all)" : "";
      console.log(
        `  - ${t.meta.id}: ${t.meta.title} (logicBearing=${t.meta.logicBearing}, securityRelevant=${t.meta.securityRelevant})${testOnly}`,
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
  const repeats = parseRepeats(args.repeats);

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

  // The matrix is a flat set of cells in executorModel → task → variant → repeat
  // order. The judge model is held FIXED so verdicts stay comparable across
  // executor models. Each cell is resource-heavy and spends quota. Campaign tasks
  // route to a SEPARATE lane: each (variant × campaign × model) runs the whole
  // chain in one persistent workspace and assembles a CampaignResult.
  const { cells, campaignCells } = buildCells(
    executorModels,
    selectedTasks,
    selectedVariants,
    repeats,
  );

  // Pairwise registry: every cell / campaign link reports its diff + context
  // here while the lanes run, so the pairwise lane never re-reads workspaces.
  const collectedDiffs: CollectedDiff[] = [];
  const onDiff: CellDiffCollector = (key, diff, context) => {
    collectedDiffs.push({ key, diff, context });
  };

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
      results.push(await runCell(cells[i]!, false, progress, runResultsDir, { onDiff }));
    }
  } else {
    // Bounded parallelism: buffer each cell's log block so lines don't interleave.
    console.error(
      `Running ${cells.length} cells, concurrency=${concurrency} (up to ${Math.min(concurrency, cells.length)} containers at once) …`,
    );
    const outcomes = await runPool(
      cells,
      concurrency,
      (cell) => runCell(cell, true, progress, runResultsDir, { onDiff }),
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

  results.sort(
    resultSortComparator(
      executorModels,
      selectedVariants.map((v) => v.name),
    ),
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
        campaigns.push(await runCampaignCell(cell, runResultsDir, { onDiff }));
      } catch (err) {
        console.error(
          `Campaign cell ${cell.variant.name} × ${cell.task.meta.id} failed unexpectedly: ${(err as Error).message}`,
        );
      }
    }
    report.campaigns = campaigns;
  }

  // Pairwise lane: same-cell A/B craft comparisons across variant pairs, after
  // BOTH lanes complete and before the report is written. Gated on the config
  // flag, --no-pairwise, and having ≥2 variants; an ineligible run skips with a
  // single line of log noise.
  const pairwiseOn = PAIRWISE_ENABLED && !args.noPairwise && selectedVariants.length >= 2;
  if (!pairwiseOn) {
    console.error("Pairwise: skipped (disabled or fewer than 2 variants).");
  } else {
    const pairJobs = buildPairJobs(collectedDiffs);
    if (pairJobs.length === 0) {
      console.error("Pairwise: skipped (no eligible pairs).");
    } else {
      console.error(`\nPairwise: judging ${pairJobs.length} comparison(s) …`);
      // Same pool settings as the cell lane. judgePair fail-closes internally
      // and never throws, but a rejected job must still not kill the run this
      // close to writeReport — hence the outcome guard.
      const outcomes = await runPool(pairJobs, concurrency, (job) => judgePair(job), {
        delayMs,
      });
      const pairwise: PairwiseResult[] = [];
      outcomes.forEach((o, i) => {
        if (o.value) pairwise.push(o.value);
        else console.error(`Pairwise job ${i} failed unexpectedly: ${o.error?.message}`);
      });
      report.pairwise = pairwise;
      const { positionBias } = aggregatePairwise(pairwise);
      console.error(
        `Pairwise position-bias audit: A-slot won ${positionBias.aSlotWins} of ${positionBias.decisive} decisive comparisons.`,
      );
    }
  }

  const { jsonPath, mdPath } = await writeReport(report, runDir, args.focus);
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
