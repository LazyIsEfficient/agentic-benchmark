import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
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
import { runVariantTask } from "./executor.js";
import { buildFailureResult, judgeRun, writeRunResult } from "./judge.js";
import { writeReport } from "./report.js";
import { buildRunFolderName } from "./runmeta.js";
import { parseVariantManifest } from "./variant.js";
import type { Report, Task, TaskMeta, Variant, VariantTaskResult } from "./types.js";

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

async function loadTasks(): Promise<Task[]> {
  const entries = await fs.readdir(TASKS_DIR, { withFileTypes: true });
  const tasks: Task[] = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory()) continue;
    const dir = path.join(TASKS_DIR, e.name);
    // Skip dirs that aren't a task yet (no meta.json) — mirrors loadVariants
    // skipping dirs without a CLAUDE.md, so an in-progress task dir doesn't
    // break the whole load. A malformed meta.json still throws (real error).
    const rawMeta = await fs.readFile(path.join(dir, "meta.json"), "utf8").catch(() => null);
    if (rawMeta === null) continue;
    const meta = JSON.parse(rawMeta) as TaskMeta;
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
  npm run bench -- --concurrency <N>      Run up to N cells in parallel (default 1)
  npm run bench -- --delay-ms <N>         Pause N ms between cells (default 0)

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
async function runCell(
  cell: Cell,
  buffered: boolean,
  progress: { completed: number; total: number },
  runResultsDir: string,
): Promise<VariantTaskResult> {
  const lines: string[] = [];
  const emit = (line: string) => {
    if (buffered) lines.push(line);
    else console.error(line);
  };

  if (!buffered) {
    console.error(`\n=== ${cell.variant.name} × ${cell.task.meta.id} [${cell.executorModel}] ===`);
  }

  const artifacts = await runVariantTask(cell.variant, cell.task, cell.executorModel, runResultsDir);
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
    result = await judgeRun(artifacts, cell.task);
  } catch (err) {
    result = buildFailureResult(artifacts, cell.task, { judge: (err as Error).message });
    emit(`  judge: FAILED — ${result.judgeFailure}`);
  }
  await writeRunResult(cellDir, result);
  emit(`  judged: total ${result.total}/100  ${formatExecLine(result.metrics.executor)}`);

  if (buffered) {
    const k = ++progress.completed;
    const header = `[${k}/${progress.total}] ${cell.variant.name} × ${cell.task.meta.id} [${cell.executorModel}]`;
    console.error(`\n${header}\n${lines.join("\n")}`);
  }
  return result;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(USAGE);
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
  const concurrency = parseConcurrency(args.concurrency, (m) =>
    console.error(`Warning: ${m}`),
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
  // models. Each cell is resource-heavy and spends quota.
  const cells: Cell[] = [];
  for (const executorModel of executorModels) {
    for (const task of selectedTasks) {
      for (const variant of selectedVariants) {
        cells.push({ executorModel, task, variant });
      }
    }
  }

  const progress = { completed: 0, total: cells.length };
  let results: VariantTaskResult[];

  if (concurrency === 1) {
    // Sequential: preserve today's streaming per-line logging exactly.
    results = [];
    for (let i = 0; i < cells.length; i++) {
      if (i > 0 && delayMs > 0) await sleep(delayMs);
      results.push(await runCell(cells[i]!, false, progress, runResultsDir));
    }
  } else {
    // Bounded parallelism: buffer each cell's log block so lines don't interleave.
    console.error(`Running ${cells.length} cells, concurrency=${concurrency} …`);
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
