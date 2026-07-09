import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runSequenceTask } from "./executor.js";
import type { ExecutorRunner } from "./executor.js";
import { detectAnchor } from "./anchors.js";
import { loadTasks } from "./cli.js";
import { renderReportMarkdown } from "./report.js";
import { git } from "./workspace.js";
import type { ContainerResult } from "./docker.js";
import type {
  AnchorResult,
  Report,
  RunArtifacts,
  Task,
  Variant,
  VariantTaskResult,
} from "./types.js";

/**
 * END-TO-END CAPSTONE for sequential-memory mode. It drives the REAL harness —
 * loadTasks (real fixtures) → runSequenceTask (real per-step workspace, commits,
 * overlay, .claude exclusion) → detectAnchor (real deterministic verdict) →
 * renderReportMarkdown (real MEMORY EFFECT renderer). The ONLY fakes are at the
 * executor boundary: two agents whose policy — carry memory vs ignore it — is all
 * that differs. The test proves the mode's two load-bearing claims:
 *   1. memory written in one step survives the per-step context reset, AND
 *   2. that same carried memory can HELP on one task and HURT on another (the
 *      anti-rigging guard: memory is not unconditionally good).
 */

const fakeResult = (over: Partial<ContainerResult> = {}): ContainerResult => ({
  stdout: "",
  stderr: "",
  exitCode: 0,
  timedOut: false,
  wallMs: 5,
  ...over,
});

// A result event carrying num_turns so the FINAL step's metrics.numTurns flows
// through the real runner into detectAnchor's turnsToGreen (proven below).
const RESULT_EVENT = '{"type":"result","subtype":"success","num_turns":4}\n';

// --- Representative source the fakes write on the anchored (step-2) step -------
// Each blob carries exactly one money signal so the REAL detectAnchor classifies
// it: integer-cents (`amountCents` + a bare `599`), float (a standalone `5.99`
// literal), or Decimal (the `.times`/`dividedBy` arithmetic idiom).

const INT_CENTS_SRC =
  "export function reprice(percentOff: number): number {\n" +
  "  const amountCents = 599;\n" +
  "  return amountCents - Math.round(amountCents * percentOff / 100);\n" +
  "}\n";

const FLOAT_SRC =
  "export const FLAT_SHIPPING_FEE = 5.99;\n" +
  "export function orderTotal(subtotalDollars: number): number {\n" +
  "  return subtotalDollars + FLAT_SHIPPING_FEE;\n" +
  "}\n";

const DECIMAL_SRC =
  'import { type Money, money } from "./money.js";\n' +
  "export function reprice(subtotal: Money, percentOff: number): Money {\n" +
  "  return subtotal.times(money(100 - percentOff)).dividedBy(100);\n" +
  "}\n";

// --- The two agent policies, as fake executors --------------------------------

interface MemoryCarryingObs {
  calls: number;
  sawMemoryAtStep2: boolean;
  memoryAtStep2: string;
}

/**
 * memory-carrying agent: on step 1 it WRITES a project-scope memory note recording
 * the codebase's money convention (integer-cents) plus a tracked source change; on
 * step 2 it READS that remembered convention and applies integer-cents BLINDLY —
 * regardless of what the current code now looks like. This is what makes memory a
 * double-edged sword: right when the convention still holds, wrong after a migration.
 */
function makeMemoryCarrying(): { exec: ExecutorRunner; obs: MemoryCarryingObs } {
  const obs: MemoryCarryingObs = { calls: 0, sawMemoryAtStep2: false, memoryAtStep2: "" };
  const exec: ExecutorRunner = async ({ workspaceDir, onStdout }) => {
    onStdout?.(RESULT_EVENT);
    obs.calls++;
    const memDir = path.join(workspaceDir, ".claude", "memory");
    const memFile = path.join(memDir, "money-convention.md");
    const srcDir = path.join(workspaceDir, "src");
    if (obs.calls === 1) {
      // STEP 1 (establish): record the convention in memory + a tracked change.
      await fs.mkdir(memDir, { recursive: true });
      await fs.writeFile(
        memFile,
        "# Money convention\nAll amounts are integer-cents — whole integers like " +
          "amountCents; never floats, never Decimal.\n",
      );
      await fs.mkdir(srcDir, { recursive: true });
      await fs.writeFile(path.join(srcDir, "establish-marker.ts"), "export const establishedCents = 100;\n");
    } else {
      // STEP 2 (apply): read remembered convention, apply integer-cents blindly.
      obs.memoryAtStep2 = await fs.readFile(memFile, "utf8").catch(() => "");
      obs.sawMemoryAtStep2 = /integer-cents/.test(obs.memoryAtStep2);
      await fs.writeFile(path.join(srcDir, "reprice.ts"), INT_CENTS_SRC);
    }
    return fakeResult();
  };
  return { exec, obs };
}

interface MemorylessObs {
  calls: number;
  currentCodeAtStep2: string;
  detectedDecimal: boolean;
}

/**
 * memoryless agent: never records or reads memory. On step 2 it reads the CURRENT
 * workspace code and mimics whatever convention that code exhibits — following a
 * strong Decimal type signal when present, but otherwise (plain-number code) it has
 * nothing anchoring it to integer-cents and naively writes the float literal the
 * task mentions (`$5.99` → `5.99`).
 */
function makeMemoryless(): { exec: ExecutorRunner; obs: MemorylessObs } {
  const obs: MemorylessObs = { calls: 0, currentCodeAtStep2: "", detectedDecimal: false };
  const exec: ExecutorRunner = async ({ workspaceDir, onStdout }) => {
    onStdout?.(RESULT_EVENT);
    obs.calls++;
    const srcDir = path.join(workspaceDir, "src");
    if (obs.calls === 1) {
      // STEP 1: a tracked change, but deliberately NO memory written.
      await fs.mkdir(srcDir, { recursive: true });
      await fs.writeFile(path.join(srcDir, "establish-marker.ts"), "export const established = 100;\n");
    } else {
      // STEP 2: ignore memory; read the current code and follow it.
      obs.currentCodeAtStep2 = await fs.readFile(path.join(srcDir, "cart.ts"), "utf8").catch(() => "");
      obs.detectedDecimal = /Decimal|\.times\(/.test(obs.currentCodeAtStep2);
      await fs.writeFile(path.join(srcDir, "reprice.ts"), obs.detectedDecimal ? DECIMAL_SRC : FLOAT_SRC);
    }
    return fakeResult();
  };
  return { exec, obs };
}

// --- The four-cell driver (real runner, fakes only at the executor seam) -------

const V_CARRYING: Variant = { name: "memory-carrying", type: "claude-md", content: "# carry memory" };
const V_MEMORYLESS: Variant = { name: "memoryless", type: "claude-md", content: "# ignore memory" };

interface Cell {
  artifacts: RunArtifacts;
  anchor: AnchorResult;
  variant: Variant;
  task: Task;
}

interface FourCells {
  helpMc: Cell & { obs: MemoryCarryingObs };
  poisonMc: Cell & { obs: MemoryCarryingObs };
  helpMl: Cell & { obs: MemorylessObs };
  poisonMl: Cell & { obs: MemorylessObs };
  runResultsDir: string;
}

/**
 * Run all four cells: {helping, poison} × {memory-carrying, memoryless}. Each cell
 * uses a FRESH fake instance — the two memory-carrying cells share the identical
 * POLICY (carry memory), not the same object, so a per-step call counter is a valid
 * step discriminator. The real fixtures' anchor configs drive detectAnchor.
 */
async function runFour(runResultsDir: string): Promise<FourCells> {
  const tasks = await loadTasks();
  const helping = tasks.find((t) => t.meta.id === "memory-cents");
  const poison = tasks.find((t) => t.meta.id === "memory-cents-stale");
  assert.ok(helping?.meta.anchor, "helping fixture must declare an anchor");
  assert.ok(poison?.meta.anchor, "poison fixture must declare an anchor");
  // Ground-truth the fixtures so the verdicts below are meaningful.
  assert.equal(helping.meta.anchor.correctConvention, "integer-cents");
  assert.equal(helping.meta.anchor.trapConvention, "decimal");
  assert.equal(poison.meta.anchor.correctConvention, "decimal");
  assert.equal(poison.meta.anchor.trapConvention, "integer-cents");

  async function drive<O>(
    variant: Variant,
    task: Task,
    factory: () => { exec: ExecutorRunner; obs: O },
  ): Promise<Cell & { obs: O }> {
    const fake = factory();
    const artifacts = await runSequenceTask(variant, task, "sonnet", runResultsDir, {
      runExecutorFn: fake.exec,
    });
    const anchor = detectAnchor(task.meta.anchor!, {
      diff: artifacts.diff,
      metrics: artifacts.executorMetrics,
      timedOut: artifacts.executorTimedOut,
    });
    return { artifacts, anchor, variant, task, obs: fake.obs };
  }

  return {
    helpMc: await drive(V_CARRYING, helping, makeMemoryCarrying),
    poisonMc: await drive(V_CARRYING, poison, makeMemoryCarrying),
    helpMl: await drive(V_MEMORYLESS, helping, makeMemoryless),
    poisonMl: await drive(V_MEMORYLESS, poison, makeMemoryless),
    runResultsDir,
  };
}

/** Build a scored VariantTaskResult carrying a real anchor verdict, for the report. */
function scoredResult(cell: Cell, anchor: AnchorResult): VariantTaskResult {
  const dim = (justification: string) => ({ score: 20, justification });
  return {
    cellId: cell.artifacts.cellId,
    variant: cell.artifacts.variant,
    taskId: cell.artifacts.taskId,
    executorModel: cell.artifacts.executorModel,
    judgeModel: "judge",
    raw: {
      codeQuality: dim("ok"),
      testingCoverage: dim("ok"),
      securityQuality: dim("ok"),
      documentation: dim("ok"),
      securityReviewPerformed: true,
      summary: "fake judge summary",
    },
    final: { codeQuality: 20, testingCoverage: 20, securityQuality: 20, documentation: 15 },
    total: 75,
    appliedCaps: [],
    signals: {
      testFilesPresent: cell.artifacts.testFilesPresent,
      securityReviewPerformed: true,
      changedFiles: cell.artifacts.changedFiles,
    },
    metrics: { executor: cell.artifacts.executorMetrics },
    anchors: anchor,
    ...(cell.artifacts.behavior ? { behavior: cell.artifacts.behavior } : {}),
  };
}

async function withTmp(fn: (runResultsDir: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bench-seq-e2e-"));
  const runResultsDir = path.join(root, "results");
  await fs.mkdir(runResultsDir, { recursive: true });
  try {
    await fn(runResultsDir);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

// --- 1) The four anchor verdicts + the money-shot contrast --------------------

test("four verdicts: memory HELPS on the helping task and HURTS on the poison task", async () => {
  await withTmp(async (runResultsDir) => {
    const { helpMc, poisonMc, helpMl, poisonMl } = await runFour(runResultsDir);

    // Every cell's executor + final step actually succeeded (real runner path).
    for (const c of [helpMc, poisonMc, helpMl, poisonMl]) {
      assert.equal(c.artifacts.executorOk, true, `${c.artifacts.cellId} should run cleanly`);
    }

    // (1) Helping + memory-carrying: remembered integer-cents is still correct.
    assert.equal(helpMc.anchor.conventionHeld, true, "V1: helping+carrying holds integer-cents");
    assert.equal(helpMc.anchor.hitKnownTrap, false, "V1: no trap on the helping task");
    // Metrics flowed through the real runner into the deterministic verdict.
    assert.equal(helpMc.anchor.turnsToGreen, 4, "V1: turnsToGreen comes from the final step's num_turns");

    // (2) Helping + memoryless: no memory ⇒ naive float ($5.99) ⇒ convention broken.
    assert.equal(helpMl.anchor.conventionHeld, false, "V2: helping+memoryless breaks (writes float 5.99)");

    // (3) Poison + memory-carrying: blindly re-applies remembered integer-cents over
    //     the migrated Decimal code ⇒ wrong convention AND lands on the known trap.
    assert.equal(poisonMc.anchor.conventionHeld, false, "V3: poison+carrying does NOT hold decimal");
    assert.equal(poisonMc.anchor.hitKnownTrap, true, "V3: poison+carrying hits the integer-cents trap");

    // (4) Poison + memoryless: reads the migrated Decimal code and follows it ⇒ correct.
    assert.equal(poisonMl.anchor.conventionHeld, true, "V4: poison+memoryless follows the migrated Decimal");
    assert.equal(poisonMl.obs.detectedDecimal, true, "V4: memoryless actually read the migrated Decimal code");

    // THE MONEY SHOT — one identical memory-carrying policy, opposite outcomes:
    // memory HELPED on the helping task and HURT on the poison task. This is the
    // anti-rigging guard: carried memory is not unconditionally beneficial.
    assert.notEqual(
      helpMc.anchor.conventionHeld,
      poisonMc.anchor.conventionHeld,
      "same memory-carrying agent must diverge across the two tasks",
    );
    assert.ok(
      helpMc.anchor.conventionHeld && !poisonMc.anchor.conventionHeld && poisonMc.anchor.hitKnownTrap,
      "memory HELPED on `memory-cents` but HURT (hit trap) on `memory-cents-stale`",
    );
  });
});

// --- 2) Persistence across the reset + per-step / overlay isolation -----------

test("memory persists across the context reset, and step-2 diffs stay isolated", async () => {
  await withTmp(async (runResultsDir) => {
    const { helpMc, poisonMc, helpMl } = await runFour(runResultsDir);

    // PERSISTENCE: memory written in step 1 was readable by the fresh step-2 context.
    assert.equal(helpMc.obs.sawMemoryAtStep2, true, "step 2 must read step 1's memory note");
    assert.match(helpMc.obs.memoryAtStep2, /integer-cents/);

    // ...and it lives on the bind mount but is NEVER git-tracked (so it can't leak
    // into a scored diff). Inspect the real workspace the runner prepared.
    const mcWorkspace = path.join(runResultsDir, `${helpMc.artifacts.taskId}__memory-carrying__sonnet`, "workspace");
    const onDisk = await fs.readFile(path.join(mcWorkspace, ".claude", "memory", "money-convention.md"), "utf8");
    assert.match(onDisk, /integer-cents/, "memory is present on disk for later steps");
    const tracked = await git(mcWorkspace, ["ls-files"]);
    assert.doesNotMatch(tracked, /\.claude/, "memory must never be committed to git");

    // ISOLATION: the FINAL (step-2) diff carries only step-2's own file — never
    // step-1's already-committed work.
    assert.match(helpMc.artifacts.diff, /reprice\.ts/, "final diff has the step-2 change");
    assert.doesNotMatch(helpMc.artifacts.diff, /establish-marker\.ts/, "final diff excludes step-1 committed work");
    assert.doesNotMatch(helpMc.artifacts.diff, /money-convention\.md/, "memory must never appear in a diff");

    // OVERLAY-NOT-ATTRIBUTED: the poison task's `migrate/` overlay (a teammate's
    // Decimal migration) is committed as step-2's baseline, so it is NOT in the
    // agent's diff even though the agent worked on top of it.
    assert.match(poisonMc.artifacts.diff, /reprice\.ts/, "poison final diff has the agent's own change");
    assert.doesNotMatch(poisonMc.artifacts.diff, /money\.ts/, "the migrated module is not in the agent's diff");
    assert.doesNotMatch(
      poisonMc.artifacts.diff,
      /migrated away from integer cents/,
      "the migration overlay text is never attributed to the agent",
    );
    assert.doesNotMatch(poisonMc.artifacts.diff, /establish-marker\.ts/, "poison final diff excludes step-1 work");

    // The memoryless agent genuinely wrote NO memory (proves the policy contrast).
    const mlMemDir = path.join(runResultsDir, `${helpMl.artifacts.taskId}__memoryless__sonnet`, "workspace", ".claude");
    await assert.rejects(fs.access(mlMemDir), "memoryless agent must not create a .claude memory tree");
  });
});

// --- 3) The MEMORY EFFECT report renders the helping-vs-poison contrast --------

test("MEMORY EFFECT report renders the helping-vs-poison contrast pivot", async () => {
  await withTmp(async (runResultsDir) => {
    const { helpMc, poisonMc, helpMl, poisonMl } = await runFour(runResultsDir);

    // Feed the REAL anchor verdicts (order: helping first, poison second, so the
    // pivot columns read `memory-cents` then `memory-cents-stale`).
    const results: VariantTaskResult[] = [
      scoredResult(helpMc, helpMc.anchor),
      scoredResult(poisonMc, poisonMc.anchor),
      scoredResult(helpMl, helpMl.anchor),
      scoredResult(poisonMl, poisonMl.anchor),
    ];
    const report: Report = {
      runId: "e2e-run",
      generatedAt: "2026-07-09T00:00:00.000Z",
      taskId: "memory-cents,memory-cents-stale",
      taskTitle: "Sequential memory",
      executorModels: ["sonnet"],
      judgeModel: "judge",
      results,
    };

    const md = renderReportMarkdown(report);

    // The section renders at all (gated on anchors being present).
    assert.match(md, /## Memory effect \(not scored\)/);
    assert.match(md, /Contrast — memory helped vs hurt/);

    // The CONTRAST pivot: the memory-carrying bundle held on the helping task but
    // hit the trap on the poison task — visible side by side in one row.
    assert.match(
      md,
      /\| memory-carrying \| ✓ held \(4 turns\) \| ✗ hit trap \|/,
      "carrying row: held on helping, hit trap on poison",
    );
    // And the memoryless bundle shows the mirror image: broke on helping, held on poison.
    assert.match(
      md,
      /\| memoryless \| ✗ broke \| ✓ held \(4 turns\) \|/,
      "memoryless row: broke on helping, held on poison",
    );

    // Both fixtures appear as anchored tasks in the readout.
    assert.match(md, /memory-cents-stale/);
    assert.match(md, /`memory-cents`/);
  });
});
