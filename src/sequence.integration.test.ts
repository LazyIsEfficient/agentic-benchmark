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
import { git, prepareWorkspace } from "./workspace.js";
import type { ContainerResult } from "./docker.js";
import type {
  AnchorResult,
  CallMetrics,
  RunArtifacts,
  Report,
  Task,
  Variant,
  VariantTaskResult,
} from "./types.js";

/**
 * END-TO-END CAPSTONE for sequential-memory mode, rebuilt around the TWO probes
 * whose knowledge is NOT re-derivable from the code the agent can see:
 *   - `memory-registry` (diff-based `registry` anchor): an arbitrary "every
 *     handler must be registered in src/registry.ts" rule stated ONCE, in step 1.
 *   - `memory-gotcha`  (trace-based `setup-gotcha` anchor): a runtime setup
 *     command (`npm run gen`) that must be re-run after an overlay relocates the
 *     generated fixtures, or the suite fails with `Cannot find module …fixtures.gen`.
 *
 * It drives the REAL harness — loadTasks (real fixtures) → runSequenceTask (real
 * per-step workspace, commits, overlay, `.claude` exclusion) → detectAnchor (real
 * deterministic verdict) → renderReportMarkdown (real MEMORY EFFECT renderer). The
 * ONLY fakes are at the executor boundary: two agents whose policy — carry memory
 * vs ignore it — is all that differs. The test proves BOTH probes actually
 * discriminate a memory-carrying bundle from a memoryless one.
 */

const fakeResult = (over: Partial<ContainerResult> = {}): ContainerResult => ({
  stdout: "",
  stderr: "",
  exitCode: 0,
  timedOut: false,
  wallMs: 5,
  ...over,
});

// A result event carrying num_turns so the anchored step's metrics.numTurns flows
// through the real runner into detectAnchor's turnsToGreen (asserted below).
const RESULT_EVENT = '{"type":"result","subtype":"success","num_turns":4}\n';

const V_CARRYING: Variant = { name: "memory-carrying", type: "claude-md", content: "# carry memory" };
const V_MEMORYLESS: Variant = { name: "memoryless", type: "claude-md", content: "# ignore memory" };

async function getTask(id: string): Promise<Task> {
  const tasks = await loadTasks();
  const t = tasks.find((x) => x.meta.id === id);
  assert.ok(t, `fixture ${id} must load`);
  return t;
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

// --- Registry-probe fakes (diff-based) --------------------------------------

interface CarryingObs {
  calls: number;
  sawMemoryAtStep2: boolean;
  memoryAtStep2: string;
}

/**
 * memory-carrying agent for `memory-registry`: on step 1 it WRITES a project-scope
 * memory note recording the codebase's registration rule plus the first handler; on
 * step 2 it READS that remembered rule and — because it remembers — registers the
 * new handler by editing `src/registry.ts`. Registering is the load-bearing act the
 * anchor detects.
 */
function makeRegistryCarrying(): { exec: ExecutorRunner; obs: CarryingObs } {
  const obs: CarryingObs = { calls: 0, sawMemoryAtStep2: false, memoryAtStep2: "" };
  const exec: ExecutorRunner = async ({ workspaceDir, onStdout }) => {
    onStdout?.(RESULT_EVENT);
    obs.calls++;
    const memDir = path.join(workspaceDir, ".claude", "memory");
    const memFile = path.join(memDir, "registration-rule.md");
    const handlersDir = path.join(workspaceDir, "src", "handlers");
    if (obs.calls === 1) {
      await fs.mkdir(memDir, { recursive: true });
      await fs.writeFile(
        memFile,
        "# Project rule\nEVERY handler MUST be registered in `src/registry.ts`. " +
          "Later step prompts stop repeating this — remember it.\n",
      );
      await fs.mkdir(handlersDir, { recursive: true });
      await fs.writeFile(
        path.join(handlersDir, "echo.ts"),
        'import type { Handler } from "../handler";\nexport const echo: Handler = (a) => a;\n',
      );
    } else {
      obs.memoryAtStep2 = await fs.readFile(memFile, "utf8").catch(() => "");
      obs.sawMemoryAtStep2 = /must be registered/i.test(obs.memoryAtStep2);
      await fs.writeFile(
        path.join(handlersDir, "reverse.ts"),
        'import type { Handler } from "../handler";\n' +
          'export const reverse: Handler = (a) => [...a].reverse().join("");\n',
      );
      // The remembered rule fires: register the new handler in src/registry.ts.
      await fs.writeFile(
        path.join(workspaceDir, "src", "registry.ts"),
        'import type { Handler } from "./handler";\nimport { ping } from "./handlers/ping";\n' +
          'import { echo } from "./handlers/echo";\nimport { reverse } from "./handlers/reverse";\n' +
          "export const registry: Record<string, Handler> = { ping, echo, reverse };\n",
      );
    }
    return fakeResult();
  };
  return { exec, obs };
}

interface MemorylessObs {
  calls: number;
}

/**
 * memoryless agent for `memory-registry`: never records or reads memory. On step 2
 * it adds the handler file the prompt asks for but — having no memory of the
 * unguessable registration rule (step 2's prompt never repeats it) — leaves
 * `src/registry.ts` untouched. The anchor catches the missed registration.
 */
function makeRegistryMemoryless(): { exec: ExecutorRunner; obs: MemorylessObs } {
  const obs: MemorylessObs = { calls: 0 };
  const exec: ExecutorRunner = async ({ workspaceDir, onStdout }) => {
    onStdout?.(RESULT_EVENT);
    obs.calls++;
    const handlersDir = path.join(workspaceDir, "src", "handlers");
    await fs.mkdir(handlersDir, { recursive: true });
    if (obs.calls === 1) {
      await fs.writeFile(
        path.join(handlersDir, "echo.ts"),
        'import type { Handler } from "../handler";\nexport const echo: Handler = (a) => a;\n',
      );
    } else {
      await fs.writeFile(
        path.join(handlersDir, "reverse.ts"),
        'import type { Handler } from "../handler";\n' +
          'export const reverse: Handler = (a) => [...a].reverse().join("");\n',
      );
    }
    return fakeResult();
  };
  return { exec, obs };
}

// --- Gotcha-probe fakes (used only to prove overlay isolation) ---------------

/**
 * memory-carrying agent for `memory-gotcha`: on step 1 records the runtime setup
 * knowledge in memory + a tracked change; on step 2 makes its own tracked change.
 * The setup-gotcha VERDICT is trace-based (proven separately with a synthetic
 * trace); this fake exists to drive the real overlay/commit path so we can prove
 * the relocated fixtures are baseline-committed and NOT attributed to the agent.
 */
function makeGotchaCarrying(): { exec: ExecutorRunner; obs: { calls: number } } {
  const obs = { calls: 0 };
  const exec: ExecutorRunner = async ({ workspaceDir, onStdout }) => {
    onStdout?.(RESULT_EVENT);
    obs.calls++;
    const strcase = path.join(workspaceDir, "src", "strcase.mjs");
    if (obs.calls === 1) {
      const memDir = path.join(workspaceDir, ".claude", "memory");
      await fs.mkdir(memDir, { recursive: true });
      await fs.writeFile(
        path.join(memDir, "setup-gotcha.md"),
        "# Runtime setup\nRun `npm run gen` (scripts/gen.mjs) to regenerate the " +
          "gitignored fixtures before the suite runs — they are never committed.\n",
      );
      await fs.appendFile(strcase, "\nexport const toScreamingSnake = (s) => toSnake(s).toUpperCase();\n");
    } else {
      await fs.appendFile(strcase, '\nexport const toDotCase = (s) => toKebab(s).replaceAll("-", ".");\n');
    }
    return fakeResult();
  };
  return { exec, obs };
}

// --- Shared driver: real runSequenceTask, fake only at the executor seam ------

async function drive(
  variant: Variant,
  task: Task,
  exec: ExecutorRunner,
  runResultsDir: string,
  prepare?: typeof prepareWorkspace,
): Promise<RunArtifacts> {
  return runSequenceTask(variant, task, "sonnet", runResultsDir, {
    runExecutorFn: exec,
    ...(prepare ? { prepare } : {}),
  });
}

/** A scored VariantTaskResult carrying a real anchor verdict, for the report. */
function scoredResult(artifacts: RunArtifacts, anchor: AnchorResult): VariantTaskResult {
  return {
    cellId: artifacts.cellId,
    variant: artifacts.variant,
    taskId: artifacts.taskId,
    executorModel: artifacts.executorModel,
    judgeModel: "judge",
    metrics: { executor: artifacts.executorMetrics },
    anchors: anchor,
    ...(artifacts.behavior ? { behavior: artifacts.behavior } : {}),
  };
}

// --- A) Persistence across the reset + per-step isolation (memory-registry) ---

test("A: memory persists across the context reset and step-2 diffs stay isolated", async () => {
  await withTmp(async (runResultsDir) => {
    const task = await getTask("memory-registry");

    // Count prepareWorkspace invocations by wrapping the real one.
    let prepareCalls = 0;
    const countingPrepare: typeof prepareWorkspace = async (...args) => {
      prepareCalls++;
      return prepareWorkspace(...args);
    };

    const { exec, obs } = makeRegistryCarrying();
    const artifacts = await drive(V_CARRYING, task, exec, runResultsDir, countingPrepare);

    // The workspace is prepared EXACTLY ONCE — any re-prepare would wipe memory.
    assert.equal(prepareCalls, 1, "prepareWorkspace must run once for the whole sequence");
    assert.equal(artifacts.executorOk, true, "final step ran cleanly");

    // PERSISTENCE: memory written in step 1 was readable by the fresh step-2 context.
    assert.equal(obs.sawMemoryAtStep2, true, "step 2 must read step 1's memory note");
    assert.match(obs.memoryAtStep2, /must be registered/i);

    // ...and it lives on the bind mount but is NEVER git-tracked (so it can't leak
    // into a scored diff). Inspect the real workspace the runner prepared.
    const workspace = path.join(runResultsDir, artifacts.cellId, "workspace");
    const onDisk = await fs.readFile(
      path.join(workspace, ".claude", "memory", "registration-rule.md"),
      "utf8",
    );
    assert.match(onDisk, /must be registered/i, "memory is present on disk for later steps");
    const tracked = await git(workspace, ["ls-files"]);
    assert.doesNotMatch(tracked, /\.claude/, "memory must never be committed to git");

    // ISOLATION: the FINAL (step-2) diff carries only step-2's own changes — never
    // step-1's already-committed file, and never the memory note.
    assert.match(artifacts.diff, /reverse\.ts/, "final diff has step-2's new handler");
    assert.doesNotMatch(artifacts.diff, /echo\.ts/, "final diff excludes step-1's committed handler");
    assert.doesNotMatch(artifacts.diff, /registration-rule\.md/, "memory must never appear in a diff");
  });
});

// --- B) Registry probe divergence (diff-based) --------------------------------

test("B: the registry probe discriminates — carrying registers, memoryless forgets", async () => {
  await withTmp(async (runResultsDir) => {
    const task = await getTask("memory-registry");
    const anchor = task.meta.anchor;
    assert.ok(anchor, "memory-registry must declare an anchor");
    assert.equal(anchor.kind, "registry");

    const carrying = makeRegistryCarrying();
    const carryingArtifacts = await drive(V_CARRYING, task, carrying.exec, runResultsDir);
    const carryingVerdict = detectAnchor(anchor, {
      diff: carryingArtifacts.diff,
      metrics: carryingArtifacts.executorMetrics,
      timedOut: carryingArtifacts.executorTimedOut,
    });

    const memoryless = makeRegistryMemoryless();
    const memorylessArtifacts = await drive(V_MEMORYLESS, task, memoryless.exec, runResultsDir);
    const memorylessVerdict = detectAnchor(anchor, {
      diff: memorylessArtifacts.diff,
      metrics: memorylessArtifacts.executorMetrics,
      timedOut: memorylessArtifacts.executorTimedOut,
    });

    // Carrying REMEMBERED the rule → its step-2 diff modifies src/registry.ts.
    assert.equal(carryingVerdict.conventionHeld, true, "carrying holds the registry rule");
    assert.equal(carryingVerdict.turnsToGreen, 4, "turnsToGreen flows from the final step's num_turns");
    assert.match(carryingArtifacts.diff, /registry\.ts/, "carrying diff actually touches registry.ts");

    // Memoryless FORGOT the rule → its step-2 diff never touches src/registry.ts.
    assert.equal(memorylessVerdict.conventionHeld, false, "memoryless breaks the registry rule");
    assert.equal(memorylessVerdict.hitKnownTrap, false, "registry rule has no trap concept");
    assert.doesNotMatch(memorylessArtifacts.diff, /registry\.ts/, "memoryless diff leaves registry.ts alone");

    // THE DIVERGENCE: the same probe, opposite verdicts across the two bundles.
    assert.notEqual(
      carryingVerdict.conventionHeld,
      memorylessVerdict.conventionHeld,
      "the registry probe must separate the memory-carrying bundle from the memoryless one",
    );
  });
});

// --- C) Gotcha probe divergence (trace-based) + overlay isolation -------------

test("C: the gotcha overlay is baseline-committed and the setup trace discriminates the trap", async () => {
  await withTmp(async (runResultsDir) => {
    const task = await getTask("memory-gotcha");
    const anchor = task.meta.anchor;
    assert.ok(anchor, "memory-gotcha must declare an anchor");
    assert.equal(anchor.kind, "setup-gotcha");

    // OVERLAY ISOLATION: drive the REAL runner. Step 2's `step-2-overlay` relocates
    // the generated fixtures (scripts/gen.mjs → writes src/generated/…, and the
    // migrated table.test.mjs). It is committed as step-2's BASELINE, so the
    // relocated/migrated files are NOT attributed to the agent's own diff.
    const gotcha = makeGotchaCarrying();
    const artifacts = await drive(V_CARRYING, task, gotcha.exec, runResultsDir);
    assert.equal(artifacts.executorOk, true, "final step ran cleanly");
    assert.match(artifacts.diff, /strcase\.mjs/, "agent's own step-2 change is in the diff");
    assert.doesNotMatch(artifacts.diff, /generated/, "relocated src/generated/… is not in the agent's diff");
    assert.doesNotMatch(artifacts.diff, /table\.test\.mjs/, "the migrated test file is baseline, not agent work");
    assert.doesNotMatch(artifacts.diff, /gen\.mjs/, "the migrated generator is baseline, not agent work");

    // VERDICT: the setup-gotcha detector reads the raw trace (file-read wiring is
    // unit-tested elsewhere), so feed SYNTHETIC final-step traces directly.
    const metrics: CallMetrics = { wallMs: 5, numTurns: 3 };

    // memory-carrying: remembered to run setup proactively → matched the setup signal,
    // never hit the missing-module trap.
    const carryingVerdict = detectAnchor(anchor, {
      diff: "",
      metrics,
      timedOut: false,
      trace:
        '{"type":"assistant"}\n' +
        '{"tool":"Bash","input":"npm run gen"}\n' +
        '{"stdout":"gen: wrote src/generated/fixtures.gen.mjs (5 cases)"}\n' +
        '{"stdout":"# tests 1\\n# pass 1"}\n',
    });

    // memoryless: a capable agent STILL reaches green — but reactively, running
    // setup only AFTER hitting the runtime gotcha. This realistic trace includes
    // the recovery `npm run gen`; the probe must still separate it from the
    // proactive bundle (holding requires NOT hitting the trap).
    const memorylessVerdict = detectAnchor(anchor, {
      diff: "",
      metrics,
      timedOut: false,
      trace:
        '{"type":"assistant"}\n' +
        '{"tool":"Bash","input":"npm test"}\n' +
        '{"stderr":"Error: Cannot find module ./src/generated/fixtures.gen.mjs"}\n' +
        '{"tool":"Bash","input":"npm run gen"}\n' +
        '{"stdout":"# tests 1\\n# pass 1"}\n',
    });

    assert.equal(carryingVerdict.conventionHeld, true, "carrying applied the remembered setup proactively");
    assert.equal(carryingVerdict.hitKnownTrap, false, "carrying avoided the trap");
    assert.equal(carryingVerdict.turnsToGreen, 3, "turnsToGreen surfaces on a held verdict");

    assert.equal(memorylessVerdict.conventionHeld, false, "memoryless ran setup only REACTIVELY → not held");
    assert.equal(memorylessVerdict.hitKnownTrap, true, "memoryless fell into the missing-module trap first");
    assert.match(memorylessVerdict.evidence, /reactive/, "the verdict names the reactive recovery");

    // THE DIVERGENCE: same probe, opposite verdicts — the memory bundle avoided the trap.
    assert.notEqual(
      carryingVerdict.conventionHeld,
      memorylessVerdict.conventionHeld,
      "the gotcha probe must separate the memory-carrying bundle from the memoryless one",
    );
    assert.ok(
      carryingVerdict.conventionHeld && memorylessVerdict.hitKnownTrap,
      "carried memory ran setup; memoryless hit the known trap",
    );
  });
});

// --- D) The MEMORY EFFECT report renders BOTH probes --------------------------

test("D: the MEMORY EFFECT report renders both the registry and the gotcha probe", async () => {
  await withTmp(async (runResultsDir) => {
    const registryTask = await getTask("memory-registry");
    const gotchaTask = await getTask("memory-gotcha");
    const registryAnchor = registryTask.meta.anchor!;
    const gotchaAnchor = gotchaTask.meta.anchor!;

    // Registry cells: REAL verdicts from the real runner + real detectAnchor.
    const regCarry = makeRegistryCarrying();
    const regCarryArt = await drive(V_CARRYING, registryTask, regCarry.exec, runResultsDir);
    const regCarryVerdict = detectAnchor(registryAnchor, {
      diff: regCarryArt.diff,
      metrics: regCarryArt.executorMetrics,
      timedOut: regCarryArt.executorTimedOut,
    });
    const regMl = makeRegistryMemoryless();
    const regMlArt = await drive(V_MEMORYLESS, registryTask, regMl.exec, runResultsDir);
    const regMlVerdict = detectAnchor(registryAnchor, {
      diff: regMlArt.diff,
      metrics: regMlArt.executorMetrics,
      timedOut: regMlArt.executorTimedOut,
    });

    // Gotcha cells: REAL runner (for cellIds/artifacts) + REAL detectAnchor over the
    // trace-based anchor with synthetic traces (the verdict source proven in C).
    const gotchaCarryArt = await drive(V_CARRYING, gotchaTask, makeGotchaCarrying().exec, runResultsDir);
    const gotchaCarryVerdict = detectAnchor(gotchaAnchor, {
      diff: "",
      metrics: { wallMs: 5, numTurns: 3 },
      timedOut: false,
      trace: '{"tool":"Bash","input":"npm run gen"}\n{"stdout":"# pass 1"}\n',
    });
    const gotchaMlArt = await drive(V_MEMORYLESS, gotchaTask, makeGotchaCarrying().exec, runResultsDir);
    const gotchaMlVerdict = detectAnchor(gotchaAnchor, {
      diff: "",
      metrics: { wallMs: 5 },
      timedOut: false,
      trace: '{"stderr":"Error: Cannot find module ./src/generated/fixtures.gen.mjs"}\n',
    });

    // Order so the pivot columns read `memory-registry` then `memory-gotcha`.
    const results: VariantTaskResult[] = [
      scoredResult(regCarryArt, regCarryVerdict),
      scoredResult(regMlArt, regMlVerdict),
      scoredResult(gotchaCarryArt, gotchaCarryVerdict),
      scoredResult(gotchaMlArt, gotchaMlVerdict),
    ];
    const report: Report = {
      runId: "e2e-run",
      generatedAt: "2026-07-09T00:00:00.000Z",
      taskId: "memory-registry,memory-gotcha",
      taskTitle: "Sequential memory",
      executorModels: ["sonnet"],
      judgeModel: "judge",
      results,
    };

    const md = renderReportMarkdown(report);

    // The section renders (gated on anchors being present).
    assert.match(md, /## Memory effect \(not scored\)/);
    assert.match(md, /Contrast — memory helped vs hurt/);

    // BOTH probes appear as anchored tasks in the readout.
    assert.match(md, /### Task: `memory-registry`/, "registry probe detail renders");
    assert.match(md, /### Task: `memory-gotcha`/, "gotcha probe detail renders");

    // The CONTRAST pivot shows one memory-carrying row that held BOTH probes, and a
    // memoryless row that broke the registry rule and hit the gotcha trap.
    assert.match(
      md,
      /\| memory-carrying \| ✓ held \(4 turns\) \| ✓ held \(3 turns\) \|/,
      "carrying row: registered on registry, ran setup on gotcha",
    );
    assert.match(
      md,
      /\| memoryless \| ✗ broke \| ✗ hit trap \|/,
      "memoryless row: missed registration, hit the gotcha trap",
    );
  });
});
