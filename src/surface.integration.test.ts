import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runVariantTask } from "./executor.js";
import type { ExecutorRunner } from "./executor.js";
import { loadTasks } from "./cli.js";
import { renderBlastRadius } from "./report.js";
import { expectedSurfaceFor, filesOutsideExpectedSurface } from "./surface.js";
import type { ContainerResult } from "./docker.js";
import type {
  BlastRadiusEntry,
  CellCraft,
  CellJudgeResult,
  Task,
  VariantTaskResult,
  Variant,
} from "./types.js";

/**
 * End-to-end proof of the BLAST-RADIUS surface path on the REAL `scope-excursion`
 * fixture (`expectedSurface: ["src/**"]`). Fakes live only at the executor
 * boundary: a fake `ExecutorRunner` writes real files into the run's workspace,
 * the REAL `runVariantTask` captures them via git, and the REAL surface detector
 * (`expectedSurfaceFor` + `filesOutsideExpectedSurface`) decides scope directly —
 * exactly how the cli wires it at scoreCell, never re-running the whole assembly.
 */

const VARIANT: Variant = { name: "naked", type: "claude-md", content: "# no memory" };

async function getScopeTask(): Promise<Task> {
  const tasks = await loadTasks();
  const t = tasks.find((t) => t.meta.id === "scope-excursion");
  assert.ok(t, "scope-excursion fixture must load");
  assert.deepEqual(t.meta.expectedSurface, ["src/**"], "fixture declares a src/** surface");
  assert.ok(!t.meta.steps && !t.meta.campaign, "fixture is a single-variant task (no steps/campaign)");
  return t;
}

async function withTmp(fn: (runResultsDir: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bench-surface-e2e-"));
  const runResultsDir = path.join(root, "results");
  await fs.mkdir(runResultsDir, { recursive: true });
  try {
    await fn(runResultsDir);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

const ok = (): ContainerResult => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false, wallMs: 1 });

async function write(workspaceDir: string, rel: string, body: string): Promise<void> {
  const dest = path.join(workspaceDir, rel);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, body);
}

/** A fake executor that writes the given files into the run's workspace. */
function writesFiles(files: Array<{ rel: string; body: string }>): ExecutorRunner {
  return async ({ workspaceDir }) => {
    for (const f of files) await write(workspaceDir, f.rel, f.body);
    return ok();
  };
}

/** Drive the REAL runVariantTask with a fake executor, then apply the REAL surface
 *  detector directly — exactly as the cli's scoreCell computes filesOutsideExpectedSurface. */
async function runAndScope(
  task: Task,
  exec: ExecutorRunner,
  runResultsDir: string,
): Promise<{ changed: string[]; outOfScope: string[] }> {
  const artifacts = await runVariantTask(VARIANT, task, "sonnet", runResultsDir, { runExecutorFn: exec });
  assert.ok(artifacts.executorOk, "fake executor run must succeed");
  const changed = artifacts.changedFiles.map((f) => f.path);
  const outOfScope = filesOutsideExpectedSurface(changed, expectedSurfaceFor(task.meta));
  return { changed, outOfScope };
}

test("surface: an out-of-scope touch is detected end-to-end, the in-scope file is not flagged", async () => {
  await withTmp(async (runResultsDir) => {
    const task = await getScopeTask();
    const exec = writesFiles([
      { rel: "src/handler.ts", body: "export const handle = () => 200;\n" },
      { rel: "config/deploy.yaml", body: "replicas: 3\n" },
    ]);
    const { changed, outOfScope } = await runAndScope(task, exec, runResultsDir);

    // Both files were captured by the real git diff.
    assert.ok(changed.includes("src/handler.ts"), "in-scope file captured");
    assert.ok(changed.includes("config/deploy.yaml"), "out-of-scope file captured");

    // The excursion list is EXACTLY the out-of-scope file — the src/ file is not flagged.
    assert.deepEqual(outOfScope, ["config/deploy.yaml"], "only the config file is out of scope");
    assert.ok(!outOfScope.includes("src/handler.ts"), "the in-scope src file is never flagged");
  });
});

test("surface: a run that stays entirely under src/ produces an empty excursion list", async () => {
  await withTmp(async (runResultsDir) => {
    const task = await getScopeTask();
    const exec = writesFiles([
      { rel: "src/handler.ts", body: "export const handle = () => 200;\n" },
      { rel: "src/util/format.ts", body: "export const fmt = (s: string) => s.trim();\n" },
    ]);
    const { changed, outOfScope } = await runAndScope(task, exec, runResultsDir);

    assert.ok(changed.includes("src/handler.ts") && changed.includes("src/util/format.ts"), "both src files captured");
    assert.deepEqual(outOfScope, [], "nothing is out of scope when every file stays under src/");
  });
});

// --- Deliverable 2 test #3: report rendering ---------------------------------

const UNKNOWN = (): { score: "unknown"; evidence: [] } => ({ score: "unknown", evidence: [] });
const CRAFT: CellCraft = {
  naming: UNKNOWN(),
  structure: UNKNOWN(),
  consistency: UNKNOWN(),
  economy: UNKNOWN(),
};

function judgeWith(blastRadius: BlastRadiusEntry[]): CellJudgeResult {
  return { craft: CRAFT, blastRadius, correctnessAssessment: null, flags: [] };
}

function resultWith(
  cellId: string,
  filesOutsideExpectedSurface: string[],
  blastRadius: BlastRadiusEntry[],
): VariantTaskResult {
  return {
    cellId,
    variant: "naked",
    taskId: "scope-excursion",
    executorModel: "sonnet",
    judgeModel: "opus",
    judge: judgeWith(blastRadius),
    filesOutsideExpectedSurface,
    metrics: { executor: { wallMs: 1 } },
  };
}

test("surface: renderBlastRadius shows the offender + classification, and disqualifies on adversarial", async () => {
  const overreach = resultWith(
    "scope-excursion__naked__sonnet",
    ["config/deploy.yaml"],
    [{ file: "config/deploy.yaml", classification: "overreach", evidence: "bumped replicas, unrequested" }],
  );
  const adversarial = resultWith(
    "scope-excursion__gamed__sonnet",
    ["scripts/run.sh"],
    [{ file: "scripts/run.sh", classification: "adversarial", evidence: "edited the harness to pass" }],
  );
  // An out-of-scope file the judge never classified falls back to `unclassified`.
  const unclassified = resultWith("scope-excursion__quiet__sonnet", ["docs/notes.md"], []);

  const md = renderBlastRadius([overreach, adversarial, unclassified]);

  // The offender file and the judge's non-adversarial classification render plainly.
  assert.match(md, /config\/deploy\.yaml/, "the overreach offender file renders");
  assert.match(md, /overreach/, "the overreach classification renders");
  assert.match(md, /bumped replicas/, "the judge's evidence renders");

  // The adversarial entry reads as a disqualifier (bold ☠ DISQUALIFIED cell) —
  // and ONLY that entry does, so a regression that disqualified every row is caught.
  assert.match(md, /scripts\/run\.sh/, "the adversarial offender file renders");
  assert.match(md, /☠ DISQUALIFIED — adversarial/, "an adversarial entry marks the cell disqualified");
  assert.equal(md.match(/☠/g)?.length, 1, "exactly one row is disqualified — the overreach row is not bold");

  // The judge-less excursion renders as `unclassified` with an em-dash for evidence.
  assert.match(md, /docs\/notes\.md/, "the unclassified offender file renders");
  assert.match(md, /unclassified/, "an out-of-scope file with no judge entry falls back to unclassified");
});
