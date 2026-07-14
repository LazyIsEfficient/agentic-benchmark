# Plan: Sequential "memory" execution mode

**Status:** implemented (not committed; awaiting a live Docker run before ship)

> All tasks complete: `tsc` clean, 204/204 unit + integration tests pass, both sequence fixtures load via `--list`. Two code-review passes (Wave 2 + Wave 3/4) addressed and re-verified. The one remaining validation is a live run through a real container with a real agent — the integration proof uses fake executors at the container boundary. Nothing is committed.

## Revisions (during execution)

- **T-mem-mechanic resolved (gate closed).** Memory is project-scope `.claude/memory/` → `/work/.claude/memory/`, on the bind mount; it **survives `--rm`** (confirmed empirically — a prior `webhook-hardening__agentic-os` run left `MEMORY.md` + entries on the host). See `docs/plans/memory-mechanic-findings.md`.
- **T-mem-persist RETIRED (folded).** Persistence needs no code change. The one hard constraint moved onto `T-seq-runner`: call `prepareWorkspace` **exactly once** per sequence and loop `runExecutor` over the same dir — re-preparing re-copies `.claude/` and would **wipe accumulated memory**. A memory-persistence regression test now lives in `T-seq-runner`.
- **T-step-seed ADDED (new task).** The poison twin needs the repo to *migrate to Decimal after step 1* (a teammate refactored it while memory was already formed) — otherwise step 1 establishing "integer cents" contradicts an already-Decimal repo. This requires a **per-step seed overlay**: files copied into the workspace and committed as baseline *before* a step (so not attributed to the agent). New on-disk contract: a step entry in `meta.json` may carry `seedOverlay: "<dir>/"`. Sequenced after `T-seq-runner` (shares `executor.ts`/`workspace.ts`/`types.ts`).
- **On-disk sequence contract (defined by the fixtures, consumed by T-wiring/T-step-seed).** `meta.json` carries `steps: [{ id, file, seedOverlay? }]` (the loader reads each `file` into `TaskStep.prompt`) plus `anchor: AnchorConfig`.

## Goal

Add a **sequential execution mode** so persistent-memory bundles (agentic-os) can demonstrate — or fail to demonstrate — cross-session value that the current single-shot, fresh-workspace design makes structurally invisible. A task may declare an **ordered list of steps** run in ONE persistent workspace: a fresh `claude -p` per step (context reset is inherent — see below), `.claude/memory` preserved across steps, and a per-step git baseline so each step's diff is isolated. The final step is judged with the existing /100 rubric, but the headline is an objective, deterministic **MEMORY EFFECT** readout (convention held? rediscovery cost?) that leads. Two seed tasks land on the mode: a *helping* pair (memory should help) and a *poison* twin (stale memory should hurt — the anti-rigging guard).

## Grounding facts (confirmed by reading the code)

- **Context reset is free.** `runExecutor` runs `claude -p … --no-session-persistence` ([src/docker.ts:223](../../src/docker.ts)). Each step is a new invocation with no carried conversation. The mode does NOT need to engineer a reset — it needs to *preserve state on disk* across resets.
- **The gate.** `baseArgs` sets `CLAUDE_CONFIG_DIR=/cfg`, and `/cfg` is ephemeral (discarded by `--rm`) ([src/docker.ts:188](../../src/docker.ts)). Memory only survives between steps if it lives under the bind-mounted `/work` (i.e. project-scope `<workspace>/.claude/memory/`). **Whether agentic-os writes there is the load-bearing unknown → T-mem-mechanic.**
- **Diffs stay clean.** For bundles the entire `.claude/` tree is in `.git/info/exclude` ([src/workspace.ts:103](../../src/workspace.ts)), so `git add -A` never captures memory writes. Per-step `git commit` between steps isolates the agent's real work while memory persists as untracked-ignored files on disk.
- **Fairness invariant.** All three bundles (agentic-os, gstack, naked) run the identical sequence with identical persistence. naked/gstack simply have nothing that writes to memory — the correct representation, not sandbagging.

## Scope

- **In:** sequence-cell mode; task-schema extension (backward-compatible); deterministic anchor module (no judge in the anchor path); two fixture tasks (`memory-cents` helping + `memory-cents-stale` poison); MEMORY EFFECT report section; wiring so all three bundles run both sequences; the existing /100 rubric judges the final step unchanged.
- **Out:** capability-matrix / cost-as-axis report reframe; multi-provider adapters (Cursor/Codex); judge cross-check on anchors; sequences longer than 2 steps.

## Execution DAG

```yaml
dag:
  - T-mem-mechanic || T-types-schema                          # day-zero ready set (both DONE)
  - T-mem-mechanic, T-types-schema → T-seq-runner
  - T-types-schema → T-anchors, T-fixture-helping, T-fixture-poison
  - T-anchors || T-fixture-helping || T-fixture-poison        # parallel after schema
  - T-seq-runner → T-step-seed                                # shares executor.ts/workspace.ts/types.ts → serialized
  - checkpoint: Foundation after [T-seq-runner, T-anchors]    # human-gate: does memory persist? do anchors detect?
  - T-types-schema, T-anchors → T-report
  - T-seq-runner, T-anchors, T-report → T-wiring
  - T-wiring, T-report, T-step-seed, T-fixture-helping, T-fixture-poison → T-integration
  - checkpoint: Complete after [T-integration]
```

(T-mem-persist retired — see Revisions.)

Day-zero ready set: **`[T-mem-mechanic, T-types-schema]`**. No two parallel tasks share a `files_write` path — each shared file (types.ts, config.ts, docker.ts, report.ts, cli.ts, judge.ts) has a single owner, so `conflicts_with` is empty throughout by construction.

---

## Task: Resolve the memory-persistence mechanic (GATE)

```yaml
id: T-mem-mechanic
depends_on: []
parallel_safe: true
conflicts_with: []
files_write:
  - docs/plans/memory-mechanic-findings.md
files_read:
  - src/docker.ts
  - src/workspace.ts
  - prompts/agentic-os/CLAUDE.md
branch_suffix: mem-mechanic
scope: S
```

**Description:** Empirically determine WHERE agentic-os writes persistent memory when it runs in the container, and whether that location survives a `--rm` between two invocations against the same bind-mounted workspace. Run agentic-os on a trivial one-shot task in the current harness; after it exits, inspect the workspace on the host for `.claude/memory/` (persists, under `/work`) vs. evidence it targeted `$CLAUDE_CONFIG_DIR=/cfg` (ephemeral). Record the finding and the required fix (if any) — e.g. "memory is project-scope, persists as-is, no change" OR "memory lands in /cfg; must redirect CLAUDE_CONFIG_DIR to a persistent path OR the sequence runner must snapshot/restore it between steps."

**Acceptance criteria:**
- [ ] Findings doc states the exact on-disk memory path agentic-os uses in-container.
- [ ] Doc gives a yes/no on "survives across two `claude -p` invocations on the same `/work`" with evidence.
- [ ] Doc prescribes the concrete fix for T-mem-persist (or "no-op — already persists").

**Verification:**
- [ ] Manual check: a two-invocation spike shows a memory file written in step 1 is readable by step 2 (or a documented reason it isn't, plus the fix).

---

## Task: Extend the task schema for sequences + anchors

```yaml
id: T-types-schema
depends_on: []
parallel_safe: true
conflicts_with: []
files_write:
  - src/types.ts
  - src/types.test.ts
branch_suffix: types-schema
scope: S
```

**Description:** Extend the type model so a task may be a **sequence** (ordered `steps`, each with its own prompt) OR remain a single-prompt task (today's shape) with zero breakage. Add: a `TaskStep` shape; an optional `steps?: TaskStep[]` on the task meta; an optional `anchor?` config (kind discriminator, e.g. `"money-cents"`, plus per-kind params) describing how the deterministic anchor is computed on the final step; and an `AnchorResult` type (`conventionHeld: boolean`, `turnsToGreen?: number`, `hitKnownTrap: boolean`, evidence string) plus an optional `anchors?: AnchorResult` field on `VariantTaskResult` for persistence. Do NOT implement detection here — types only.

**Acceptance criteria:**
- [ ] `TaskStep`, `AnchorConfig` (discriminated), and `AnchorResult` types exist and are exported.
- [ ] Existing single-prompt `Task`/`TaskMeta` consumers still typecheck unchanged (fields additive/optional).
- [ ] `VariantTaskResult` carries an optional `anchors` field.

**Verification:**
- [ ] Build succeeds: `npx tsc --noEmit`
- [ ] Tests pass: `npx tsx --test src/types.test.ts` (or the repo's test runner scoped to types)

---

## Task: Guarantee memory persists across steps

```yaml
id: T-mem-persist
depends_on: [T-mem-mechanic]
parallel_safe: true
conflicts_with: []
files_write:
  - src/docker.ts
  - src/config.ts
  - src/docker.test.ts
branch_suffix: mem-persist
scope: S
```

**Description:** Implement whatever T-mem-mechanic prescribed so the memory store survives across step invocations in one workspace. If the finding is "already project-scope, persists" this is a no-op assertion + a regression test. If the finding is "lands in /cfg", implement the fix (e.g. point `CLAUDE_CONFIG_DIR` at a persistent bind-mounted subdir of `/work`, or add a documented snapshot/restore hook the runner can call) with a config constant so it is not a magic path. Must NOT change single-cell behavior (the existing single-shot pipeline still discards `/cfg` as before, or the redirect is scoped so it is harmless).

**Acceptance criteria:**
- [ ] Memory written during one container invocation is present in the workspace for the next invocation.
- [ ] Single-cell path behavior is unchanged (no persistence leaks between unrelated cells).
- [ ] Any new path is a named constant in config.ts, not inline.

**Verification:**
- [ ] Tests pass: `npx tsx --test src/docker.test.ts`
- [ ] Build succeeds: `npx tsc --noEmit`

---

## Task: Sequence-cell runner (prepare-once, per-step commit + capture)

```yaml
id: T-seq-runner
depends_on: [T-mem-mechanic, T-types-schema, T-mem-persist]
parallel_safe: true
conflicts_with: []
files_write:
  - src/executor.ts
  - src/workspace.ts
  - src/capture.ts
  - src/executor.test.ts
branch_suffix: seq-runner
scope: M
```

**Description:** Add `runSequenceTask` alongside `runVariantTask`. Refactor `prepareWorkspace` into prepare-once (baseline commit + variant/bundle materialization happen a single time) and expose a per-step "commit the step's tracked work" helper. For each step in order: invoke `runExecutor` against the SAME workspace (context reset is inherent via `--no-session-persistence`); capture that step's artifacts by diffing against the PREVIOUS step's commit (extend `captureArtifacts` to accept a baseline ref, defaulting to the baseline for single-cell callers); then `git add -A && git commit` so the next step diffs cleanly. `.claude/` (incl. memory) is excluded from every commit and therefore persists untouched on disk between steps. Retain the existing single-cell path unchanged. The final step's artifacts feed the judge + anchors.

**Acceptance criteria:**
- [ ] `runSequenceTask` runs N steps in one workspace; step K's diff excludes step K-1's committed work.
- [ ] `.claude/memory/` written in step 1 is present on disk when step 2 runs.
- [ ] Single-prompt tasks still route through the unchanged single-cell path.
- [ ] `captureArtifacts` baseline-ref param defaults to preserve existing callers.

**Verification:**
- [ ] Tests pass: `npx tsx --test src/executor.test.ts` (inject a fake executor that writes a memory file in step 1 and reads it in step 2; assert per-step diff isolation + memory presence).
- [ ] Build succeeds: `npx tsc --noEmit`

---

## Task: Deterministic anchor detection

```yaml
id: T-anchors
depends_on: [T-types-schema]
parallel_safe: true
conflicts_with: []
files_write:
  - src/anchors.ts
  - src/anchors.test.ts
branch_suffix: anchors
scope: M
```

**Description:** New module computing `AnchorResult` from the final step's diff + metrics — NO judge involved. For `money-cents`: `conventionHeld` = the step-2 diff represents money as integer cents with no floating-point on money paths (deterministic scan: rejects `parseFloat`, float literals, `.toFixed`-style handling on money-typed values; the exact heuristic is pinned against the fixture). For the poison variant the SAME detector is reused with the config declaring that the *current-code* convention is the migrated Decimal/BigInt type — `conventionHeld` there means "followed the code, not the stale memory." `turnsToGreen` comes from `CallMetrics.numTurns`; `hitKnownTrap` from `executorTimedOut` (and any declared rediscovery marker). Pure functions over strings/metrics — fully unit-testable with fixture diffs.

**Acceptance criteria:**
- [ ] Given a known integer-cents diff → `conventionHeld: true`; given a float-money diff → `false`.
- [ ] Poison config: a diff using the migrated Decimal type → `conventionHeld: true`; a diff blindly re-applying integer cents → `false`.
- [ ] `turnsToGreen`/`hitKnownTrap` read from metrics; no judge call anywhere in the module.

**Verification:**
- [ ] Tests pass: `npx tsx --test src/anchors.test.ts` (table of fixture diffs → expected AnchorResult, both variants).

---

## Task: Fixture — `memory-cents` (helping pair)

```yaml
id: T-fixture-helping
depends_on: [T-types-schema]
parallel_safe: true
conflicts_with: []
files_write:
  - tasks/memory-cents/meta.json
  - tasks/memory-cents/step-1.md
  - tasks/memory-cents/step-2.md
  - tasks/memory-cents/seed/
branch_suffix: fixture-helping
scope: M
```

**Description:** A minimal money-handling fixture repo (seed files) plus a two-step sequence. Step 1: a small money task whose prompt STATES the convention — "money is stored as integer cents, never floats." Step 2: a NEW money task (e.g. add a discount/refund calculation) whose prompt does NOT restate the convention and whose knowledge is NOT re-derivable from the seed code. `meta.json` declares `steps` + a `money-cents` anchor config (current convention = integer cents). Convention must be genuinely absent from step-2's code/prompt so memory is the only carrier.

**Acceptance criteria:**
- [ ] `tasks/memory-cents/` loads as a sequence task under the new schema.
- [ ] Step-2 prompt does not mention the integer-cents convention; seed code does not encode it in a re-derivable way.
- [ ] Anchor config present and consumable by T-anchors.

**Verification:**
- [ ] Manual check: `npm run bench -- --list` shows the task; a dry structural load parses both steps + anchor config.

---

## Task: Fixture — `memory-cents-stale` (poison twin)

```yaml
id: T-fixture-poison
depends_on: [T-types-schema]
parallel_safe: true
conflicts_with: []
files_write:
  - tasks/memory-cents-stale/meta.json
  - tasks/memory-cents-stale/step-1.md
  - tasks/memory-cents-stale/step-2.md
  - tasks/memory-cents-stale/seed/
branch_suffix: fixture-poison
scope: M
```

**Description:** Same step 1 as the helping pair (establishes "integer cents"). Step 2's seed repo has MIGRATED to a Decimal/BigInt money type that is VISIBLE in the current code — so blindly re-applying the remembered "integer cents" convention is now WRONG. Correct behavior = trust the current code over stale memory (which agentic-os's own doctrine mandates). `meta.json` anchor config declares the current-code convention = the migrated type, so `conventionHeld: true` means "followed the code." This task is the anti-rigging guard: the mode MUST be able to show memory hurting.

**Acceptance criteria:**
- [ ] Step-2 seed code visibly uses the migrated Decimal/BigInt money type.
- [ ] Anchor config marks integer-cents as the STALE answer and the migrated type as correct.
- [ ] Step 1 is identical to `memory-cents` step 1 (same convention established).

**Verification:**
- [ ] Manual check: task loads as a sequence; anchor config inverts the "correct" convention relative to the helping fixture.

---

## Task: MEMORY EFFECT report section

```yaml
id: T-report
depends_on: [T-types-schema, T-anchors]
parallel_safe: true
conflicts_with: []
files_write:
  - src/report.ts
  - src/report.test.ts
branch_suffix: report
scope: M
```

**Description:** Add a `MEMORY EFFECT` section to report.md and report.json for sequence tasks. Per bundle: `conventionHeld`, `turnsToGreen`, `hitKnownTrap`, plus the helping-vs-poison contrast that demonstrates the track can surface memory losing. Anchors LEAD; the existing /100 (final-step rubric) renders as secondary context beneath. Non-sequence reports are unchanged. Must degrade gracefully when `anchors` is absent (old report.json).

**Acceptance criteria:**
- [ ] Sequence results render a MEMORY EFFECT table (md) and a structured block (json).
- [ ] Helping and poison rows are visibly contrasted for the same bundle.
- [ ] Single-shot reports render exactly as today; missing `anchors` degrades to `—`.

**Verification:**
- [ ] Tests pass: `npx tsx --test src/report.test.ts` (fixture Report with sequence results → asserts section content + graceful absence).
- [ ] Build succeeds: `npx tsc --noEmit`

---

## Task: Wire sequences through the orchestrator

```yaml
id: T-wiring
depends_on: [T-seq-runner, T-anchors, T-report]
parallel_safe: true
conflicts_with: []
files_write:
  - src/cli.ts
  - src/judge.ts
  - src/cli.test.ts
branch_suffix: wiring
scope: M
```

**Description:** Teach `loadTasks` to parse `steps` from `meta.json` (a sequence task) vs a single `task.md`. Route sequence tasks through `runSequenceTask`; after the final step, run the deterministic anchor detection and attach `AnchorResult` to the `VariantTaskResult`; ensure `judgeRun`/`writeRunResult` judge the FINAL step with the unchanged rubric and persist the anchors. Non-sequence tasks route exactly as today. Confirm all three bundles (agentic-os, gstack, naked) enumerate against both new fixtures in the cell matrix.

**Acceptance criteria:**
- [ ] `meta.json` with `steps` loads and dispatches through the sequence runner; legacy tasks unchanged.
- [ ] Final-step judging + anchor computation both populate the persisted result.
- [ ] The three bundles × two fixtures appear as cells.

**Verification:**
- [ ] Tests pass: `npx tsx --test src/cli.test.ts` (loader recognizes sequence vs single; dispatch routes correctly with an injected runner).
- [ ] Build succeeds: `npx tsc --noEmit`

---

## Task: Integration proof (persistence + helping-vs-poison divergence)

```yaml
id: T-integration
depends_on: [T-wiring, T-report, T-fixture-helping, T-fixture-poison]
parallel_safe: true
conflicts_with: []
files_write:
  - src/sequence.integration.test.ts
branch_suffix: integration
scope: M
```

**Description:** An end-to-end harness test (injected/fake executor, no live Docker) proving the two load-bearing claims: (1) memory written in step 1 is visible to step 2 in one persistent workspace while per-step diffs stay isolated; (2) the helping fixture yields `conventionHeld: true` for a memory-carrying executor and `false` for a memoryless one, while the poison fixture INVERTS it (memoryless-following-code passes, blindly-remembering fails) — demonstrating the mode can show memory both helping and hurting. Assert the MEMORY EFFECT section renders the contrast.

**Acceptance criteria:**
- [ ] Persistence + per-step diff isolation asserted through the real runner (fake executor).
- [ ] Helping vs poison produce OPPOSITE anchor verdicts for the same simulated memory behavior.
- [ ] Rendered report contains the MEMORY EFFECT contrast.

**Verification:**
- [ ] Tests pass: `npx tsx --test src/sequence.integration.test.ts`
- [ ] Full build + suite green: `npx tsc --noEmit && npm test`

---

## Checkpoints

- **Foundation** (after T-seq-runner, T-anchors): human-review gate. Confirm empirically that memory persists across a reset and that the anchor detector classifies known diffs correctly BEFORE report/wiring build on top. This is where the gating unknown is finally closed in running code.
- **Complete** (after T-integration): full suite green; both fixtures runnable across all three bundles; MEMORY EFFECT section demonstrably able to show memory losing.

## Verification checklist

- [x] `**Status:**` line present (proposed)
- [x] Every task has a stable slug id
- [x] Every task has acceptance + verification
- [x] Every task declares depends_on / parallel_safe / files_write
- [x] No two parallel tasks share a files_write path (single-owner design → conflicts_with empty)
- [x] Non-empty day-zero ready set: `[T-mem-mechanic, T-types-schema]`
- [x] No task is scope L; none touch > 5 files
- [x] DAG matches per-task depends_on
- [x] Checkpoints between phases (Foundation, Complete)
- [ ] Human has reviewed and approved the plan
