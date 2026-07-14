import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runCampaign } from "./executor.js";
import type { ExecutorRunner } from "./executor.js";
import { detectAnchor } from "./anchors.js";
import { loadTasks } from "./cli.js";
import { renderReportMarkdown } from "./report.js";
import type { ContainerResult } from "./docker.js";
import type { AnchorResult, CampaignResult, Report, Task, Variant } from "./types.js";

/**
 * End-to-end proof of the LONGITUDINAL campaign mode on the REAL fixture. Fakes
 * live only at the executor boundary: a memory-carrying agent records the two
 * conventions (R1 epoch-seconds, R2 ulid_ format) on links 1-2 and APPLIES them on links
 * 3-5; a memoryless agent writes the natural DEFAULT that DRIFTS. The verdict is
 * the REAL `detectAnchor` on the REAL fixture anchors, driven by the REAL
 * `runCampaign` (one persistent workspace, memory accumulating across links).
 */

const V_CARRYING: Variant = { name: "agentic-os", type: "claude-md", content: "# memory discipline" };
const V_MEMORYLESS: Variant = { name: "naked", type: "claude-md", content: "# no memory" };

async function getCampaignTask(): Promise<Task> {
  const tasks = await loadTasks();
  const t = tasks.find((t) => t.meta.id === "campaign-conventions");
  assert.ok(t, "campaign-conventions fixture must load");
  assert.ok(t.meta.campaign && t.meta.campaign.length === 5, "fixture must resolve 5 links");
  return t;
}

async function withTmp(fn: (runResultsDir: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bench-camp-e2e-"));
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

const MEMORY_FILE = path.join(".claude", "memory", "conventions.md");

/**
 * Memory-carrying agent: records R1 on link 1 and R2 on link 2 (proving memory
 * accumulates), reads them back on link 3 (proving persistence across the reset),
 * and writes convention-ADHERING code on links 3/4/5.
 */
function makeCarrying(): ExecutorRunner {
  let call = 0;
  return async ({ workspaceDir }) => {
    call++;
    if (call === 1) {
      await write(workspaceDir, MEMORY_FILE, "R1: timestamps are Unix SECONDS — Math.floor(Date.now() / 1000).\n");
      await write(workspaceDir, "src/search.ts", "export const search = () => [];\n");
    } else if (call === 2) {
      await fs.appendFile(path.join(workspaceDir, MEMORY_FILE), "R2: entity ids are `ulid_<8 base36>`, never randomUUID.\n");
      await write(workspaceDir, "src/rename.ts", "export const rename = () => {};\n");
    } else if (call === 3) {
      // Persistence proof: the note written on link 1 survived the context reset.
      const note = await fs.readFile(path.join(workspaceDir, MEMORY_FILE), "utf8");
      assert.match(note, /Math\.floor/, "R1 note must persist into link 3");
      assert.match(note, /ulid_/, "R2 note must persist into link 3");
      await write(workspaceDir, "src/createdAt.ts", "export const stamp = () => Math.floor(Date.now() / 1000);\n");
    } else if (call === 4) {
      await write(workspaceDir, "src/attach.ts", "export const mint = () => `ulid_${Math.random().toString(36).slice(2, 10)}`;\n");
    } else {
      await write(
        workspaceDir,
        "src/revision.ts",
        "export const rev = () => ({ at: Math.floor(Date.now() / 1000), id: `ulid_${Math.random().toString(36).slice(2, 10)}` });\n",
      );
    }
    return ok();
  };
}

/**
 * Memoryless agent: records NOTHING, and on links 3/4/5 writes the natural JS
 * default that DRIFTS from both conventions (bare ms `Date.now()` / a `Date`
 * object; `crypto.randomUUID()`).
 */
function makeMemoryless(): ExecutorRunner {
  let call = 0;
  return async ({ workspaceDir }) => {
    call++;
    if (call === 1) {
      await write(workspaceDir, "src/search.ts", "export const search = () => [];\n");
    } else if (call === 2) {
      await write(workspaceDir, "src/rename.ts", "export const rename = () => {};\n");
    } else if (call === 3) {
      await write(workspaceDir, "src/createdAt.ts", "export const stamp = () => Date.now();\n"); // bare ms → R1 drift
    } else if (call === 4) {
      await write(
        workspaceDir,
        "src/attach.ts",
        "import { randomUUID } from 'node:crypto';\nexport const mint = () => randomUUID();\n", // R2 trap
      );
    } else {
      await write(
        workspaceDir,
        "src/revision.ts",
        "import { randomUUID } from 'node:crypto';\nexport const rev = () => ({ at: new Date().toISOString(), id: randomUUID() });\n", // both drift
      );
    }
    return ok();
  };
}

interface LinkRow {
  index: number;
  campaignTaskId: string;
  diff: string;
  hasAnchor: boolean;
  verdict?: AnchorResult;
}

/** Drive the REAL runCampaign with a fake executor, then apply the REAL detector. */
async function runAndAnchor(
  variant: Variant,
  task: Task,
  exec: ExecutorRunner,
  runResultsDir: string,
): Promise<LinkRow[]> {
  const links = await runCampaign(variant, task, "sonnet", runResultsDir, { runExecutorFn: exec });
  const campaign = task.meta.campaign ?? [];
  return links.map((link) => {
    const anchor = campaign[link.index]?.anchor;
    const verdict =
      anchor && link.artifacts.executorOk
        ? detectAnchor(anchor, {
            diff: link.artifacts.diff,
            metrics: link.artifacts.executorMetrics,
            timedOut: link.artifacts.executorTimedOut,
          })
        : undefined;
    return {
      index: link.index,
      campaignTaskId: link.campaignTaskId,
      diff: link.artifacts.diff,
      hasAnchor: anchor !== undefined,
      ...(verdict ? { verdict } : {}),
    };
  });
}

const adheredCount = (rows: LinkRow[]): number =>
  rows.filter((r) => r.verdict?.conventionHeld === true).length;
const anchoredCount = (rows: LinkRow[]): number => rows.filter((r) => r.hasAnchor).length;

test("campaign: memory-carrying adheres on every anchored link, memory persists, links isolate", async () => {
  await withTmp(async (runResultsDir) => {
    const task = await getCampaignTask();
    const rows = await runAndAnchor(V_CARRYING, task, makeCarrying(), runResultsDir);

    // Anchored links are t3/t4/t5 (indices 2,3,4); all held → cumulative 3/3.
    assert.equal(anchoredCount(rows), 3, "three links carry a rule anchor");
    assert.equal(adheredCount(rows), 3, "memory-carrying adheres on all three");
    for (const r of rows.filter((x) => x.hasAnchor)) {
      assert.equal(r.verdict?.conventionHeld, true, `link ${r.index} (${r.campaignTaskId}) held`);
    }

    // Per-link isolation: link 3's diff is its OWN change, not link 1's committed work.
    const link3 = rows[2]!;
    assert.match(link3.diff, /createdAt\.ts/, "link 3 diff shows its own file");
    assert.doesNotMatch(link3.diff, /search\.ts/, "link 3 diff excludes link 1's committed file");

    // Memory is never committed / never attributed to any link's diff.
    for (const r of rows) {
      assert.doesNotMatch(r.diff, /conventions\.md/, `link ${r.index} diff must not contain the memory note`);
      assert.doesNotMatch(r.diff, /\.claude\/memory/, `link ${r.index} diff must not contain .claude/memory`);
    }
  });
});

test("campaign: memoryless drifts on every anchored link (0/3), hits the id trap", async () => {
  await withTmp(async (runResultsDir) => {
    const task = await getCampaignTask();
    const rows = await runAndAnchor(V_MEMORYLESS, task, makeMemoryless(), runResultsDir);

    assert.equal(anchoredCount(rows), 3);
    assert.equal(adheredCount(rows), 0, "memoryless drifts on all three");
    for (const r of rows.filter((x) => x.hasAnchor)) {
      assert.equal(r.verdict?.conventionHeld, false, `link ${r.index} (${r.campaignTaskId}) drifts`);
    }
    // t4 (index 3) reached for crypto.randomUUID → the R2 known trap fires.
    assert.equal(rows[3]!.verdict?.hitKnownTrap, true, "randomUUID trips the R2 trap");
  });
});

test("campaign: the 3/3-vs-0/3 divergence renders in the Memory effect (campaign) section", async () => {
  await withTmp(async (runResultsDir) => {
    const task = await getCampaignTask();
    const carry = await runAndAnchor(V_CARRYING, task, makeCarrying(), runResultsDir);
    const memless = await runAndAnchor(V_MEMORYLESS, task, makeMemoryless(), runResultsDir);

    // The money shot: identical fixture, opposite cumulative adherence.
    assert.equal(adheredCount(carry), 3);
    assert.equal(adheredCount(memless), 0);
    assert.notEqual(adheredCount(carry), adheredCount(memless));

    const toResult = (variant: string, rows: LinkRow[]): CampaignResult => ({
      variant,
      executorModel: "sonnet",
      campaignId: task.meta.id,
      tasks: rows.map((r) => ({
        taskId: r.campaignTaskId,
        index: r.index,
        metrics: { wallMs: 1 },
        score: 75,
        ...(r.verdict ? { anchors: r.verdict } : {}),
      })),
    });

    const report: Report = {
      runId: "camp-e2e",
      generatedAt: "2026-07-10T00:00:00.000Z",
      taskId: task.meta.id,
      taskTitle: task.meta.title,
      executorModels: ["sonnet"],
      judgeModel: "opus",
      results: [],
      campaigns: [toResult("agentic-os", carry), toResult("naked", memless)],
    };

    const md = renderReportMarkdown(report);
    assert.match(md, /Memory effect \(campaign/, "campaign memory-effect section renders");
    assert.match(md, /3\/3/, "agentic-os cumulative 3/3 shown");
    assert.match(md, /0\/3/, "naked cumulative 0/3 shown");
  });
});
