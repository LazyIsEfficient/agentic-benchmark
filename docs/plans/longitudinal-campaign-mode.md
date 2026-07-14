# Plan: Longitudinal "campaign" mode

**Status:** proposed

## Goal

Measure persistent memory's COMPOUNDING value — the thing three single-pair probes proved a 2-step task can't show. A **campaign** is a chain of 5 related tasks run in ONE persistent workspace per bundle, fresh `claude -p` per task (context reset), `.claude/memory` persisting across the whole chain, with EACH task judged (/100) and checked by a deterministic per-task convention-adherence anchor. Headline: does a memory bundle (agentic-os) stay consistent with arbitrary conventions established in early tasks while a memoryless bundle (naked/gstack) drifts — shown as a cumulative adherence delta + per-task trajectory. Additive; the single-pair sequence mode and its anchors are untouched.

## The load-bearing anti-leak design (where the last 3 probes died)

Conventions must be **non-re-derivable**. The pattern: **staggered arbitrary rules, stated early, relevant later, with NO intervening code footprint.**

- **T1** (real task) states rule **R1**: "never use a date library — always native `Intl`." Irrelevant to T1–T2 → leaves no code trace.
- **T2** (real task) states rule **R2**: "all IDs are ULIDs via `newId()`, never `crypto.randomUUID`."
- **T3** needs a date → must follow R1. A memoryless bundle sees no date code and no rule in-context → defaults to a date lib → **drifts**. [anchor R1]
- **T4** mints an ID → must follow R2. [anchor R2]
- **T5** touches both → R1+R2. [anchor R1+R2]

Rules are ARBITRARY (a memoryless agent's default differs) and DIFF-CHECKABLE (imports `date-fns`/`dayjs` or `randomUUID` = drift; `Intl`/`newId()` = adhered). The memory bundle records R1/R2 in T1–T2 and adheres on T3–T5; the memoryless bundle has no way to know them. **If any rule leaves a code footprint the later agent can read, that task returns a null result — the exact failure to avoid.**

## On-disk campaign contract (fixture + schema + loader must agree)

`tasks/<id>/meta.json`:
```json
{
  "id": "campaign-conventions",
  "title": "...",
  "campaign": [
    { "id": "t1-...", "file": "t1.md" },
    { "id": "t2-...", "file": "t2.md" },
    { "id": "t3-...", "file": "t3.md",
      "anchor": { "kind": "rule", "label": "R1 date=Intl",
                  "required": ["Intl\\."], "forbidden": ["date-fns|dayjs|moment"] } },
    { "id": "t4-...", "file": "t4.md",
      "anchor": { "kind": "rule", "label": "R2 id=newId",
                  "required": ["newId\\("], "forbidden": ["\\brandomUUID\\b"] } },
    { "id": "t5-...", "file": "t5.md",
      "anchor": { "kind": "rule", "label": "R1+R2",
                  "required": ["Intl\\.", "newId\\("], "forbidden": ["date-fns|dayjs|moment", "\\brandomUUID\\b"] } }
  ],
  "seedFiles": ["seed/..."]
}
```
`RuleAnchor` = `{ kind: "rule", label?, required?: string[], forbidden?: string[] }` (regex sources over the task's diff). `conventionHeld` = ALL `required` present AND NO `forbidden` present; fails closed. A task with no `anchor` is judged only.

## Signal

Deterministic (not judge): primary = **cumulative convention-adherence** (count of adhered anchored tasks, memory vs memoryless) + a **per-task adherence trajectory** (✓/✗). Secondary = per-task cost (turns/$) trajectory.

## Execution DAG

```yaml
dag:
  - T-camp-schema → T-rule-anchor, T-camp-runner, T-camp-fixture, T-camp-report
  - T-rule-anchor || T-camp-runner || T-camp-fixture           # parallel wave after schema
  - checkpoint: Foundation after [T-rule-anchor, T-camp-runner, T-camp-fixture]
  - T-camp-report                                              # after Foundation (schema-only dep)
  - T-rule-anchor, T-camp-runner, T-camp-report → T-camp-wiring
  - T-camp-wiring, T-camp-fixture, T-camp-report → T-camp-integration
  - checkpoint: Complete after [T-camp-integration]
```

Day-zero ready set: **`[T-camp-schema]`**. Single-owner files throughout (types.ts, anchors.ts, executor.ts, report.ts, cli.ts each one owner; judge.ts reused unchanged) ⇒ every `conflicts_with` is empty.

---

## Task: Campaign schema + rule-anchor + result types

```yaml
id: T-camp-schema
depends_on: []
parallel_safe: true
conflicts_with: []
files_write:
  - src/types.ts
  - src/types.test.ts
branch_suffix: camp-schema
scope: M
```

**Description:** Extend the type model (types-only; no logic). Add: (1) a campaign shape — a task meta may carry `campaign: CampaignTask[]` where `CampaignTask = { id?: string; prompt: string; anchor?: AnchorConfig }` (the on-disk DTO uses `file`, resolved to `prompt` by the loader). (2) `RuleAnchor = { kind: "rule"; label?: string; required?: string[]; forbidden?: string[] }`, added to the `AnchorConfig` union (money-cents/registry/setup-gotcha kept). (3) `CampaignTaskResult = { taskId: string; index: number; score?: number; anchors?: AnchorResult; metrics: CallMetrics; failure?: string }` and `CampaignResult = { variant: string; executorModel: string; campaignId: string; tasks: CampaignTaskResult[] }`. (4) `Report` gains optional `campaigns?: CampaignResult[]`. All additive/optional so existing consumers compile unchanged.

**Acceptance:**
- [ ] `AnchorConfig` is a 4-kind union incl. `RuleAnchor`; existing kinds untouched.
- [ ] `campaign`, `CampaignTask`, `CampaignTaskResult`, `CampaignResult`, `Report.campaigns` exist and are exported.
- [ ] Existing single-pair/single-shot types still compile.

**Verification:**
- [ ] `npx tsc --noEmit` clean.
- [ ] `src/types.test.ts` constructs a campaign meta + a RuleAnchor + a CampaignResult and typechecks.

---

## Task: `rule` anchor detector

```yaml
id: T-rule-anchor
depends_on: [T-camp-schema]
parallel_safe: true
conflicts_with: []
files_write:
  - src/anchors.ts
  - src/anchors.test.ts
branch_suffix: rule-anchor
scope: S
```

**Description:** Add the `rule` case to `detectAnchor`. Over the task's diff: `conventionHeld` = every `config.required` regex matches the added lines AND no `config.forbidden` regex matches. Reuse `extractAddedLines`/`stripComments` (comments already stripped — a rule marker in a comment must not count). `hitKnownTrap` = a `forbidden` marker was found (drifted to the banned default). `turnsToGreen` from numTurns when held. Malformed regex → fail closed (try/catch, like setup-gotcha). Evidence names which required marker was missing or which forbidden marker was hit — never dumps the diff. Keep money-cents/registry/setup-gotcha untouched.

**Acceptance:**
- [ ] required-present + forbidden-absent ⇒ held; a missing required OR a present forbidden ⇒ not held (with `hitKnownTrap` set when a forbidden matched).
- [ ] A required/forbidden marker appearing only in a COMMENT does not count.
- [ ] Malformed regex fails closed without throwing.

**Verification:**
- [ ] `npx tsx --test src/anchors.test.ts` — new rule tests + all existing anchor tests pass.

---

## Task: Campaign runner

```yaml
id: T-camp-runner
depends_on: [T-camp-schema]
parallel_safe: true
conflicts_with: []
files_write:
  - src/executor.ts
  - src/executor.test.ts
branch_suffix: camp-runner
scope: M
```

**Description:** Add `runCampaign(variant, task, executorModel, runResultsDir, deps?)` alongside `runSequenceTask`. Prepare the workspace ONCE (reuse `prepareWorkspace`; append the unconditional `.claude/` exclude as the sequence path does — memory must never be committed). For each campaign task in order: run `runExecutor` against the same workspace (context reset inherent), tee `trace-task-<n>.ndjson`, capture that task's artifacts diffing against the previous task's commit (reuse `captureArtifacts` baselineRef), write `diff-task-<n>.patch`, then `commitStep` to advance. Return an ARRAY of per-task `RunArtifacts` (NOT just the final — every task is judged downstream). A task whose executor fails is recorded as a failed entry and the chain CONTINUES (a mid-chain stall must not lose earlier tasks). Do NOT judge or anchor here (CLI does that per task). Leave `runSequenceTask`/`runOnce` unchanged.

**Acceptance:**
- [ ] Prepares workspace exactly once; memory written in task 1 is readable in task 5.
- [ ] Returns one `RunArtifacts` per campaign task; task-N diff excludes task-(N-1)'s committed work.
- [ ] A failed middle task yields a failed entry AND later tasks still run.

**Verification:**
- [ ] `npx tsx --test src/executor.test.ts` — inject a fake executor writing/reading `.claude/memory` across tasks; assert per-task diff isolation, memory persistence, prepare-once, and continue-on-failure.

---

## Task: 5-task campaign fixture (staggered rules)

```yaml
id: T-camp-fixture
depends_on: [T-camp-schema]
parallel_safe: true
conflicts_with: []
files_write:
  - tasks/campaign-conventions/
branch_suffix: camp-fixture
scope: M
```

**Description:** Author `tasks/campaign-conventions/` per the on-disk contract above: a small seed library the agent extends over 5 tasks, `t1.md`–`t5.md`, and `meta.json` with the 5-entry `campaign` + per-task `rule` anchors on T3/T4/T5. Enforce the ANTI-LEAK invariant: R1 (Intl-not-date-lib) and R2 (ULID-not-randomUUID) are stated ONLY in T1/T2 prompts, the seed has NO date/ID code, and T1/T2's real work leaves no date/ID footprint — so at T3/T4 the rule is genuinely absent from everything the agent can see. Each early task must be a genuine small task (not just "remember this") so the rule is stated as an aside a memory-disciplined agent records. T3/T4/T5 prompts must NOT restate the rules. Verify the anchor markers match what a correct vs drifted solution's diff would contain.

**Acceptance:**
- [ ] `meta.json` valid; 5 campaign entries; T3/T4/T5 carry rule anchors matching the contract.
- [ ] Grep-clean: no `date`/`Intl`/`randomUUID`/`newId`/`uuid` tokens in the seed or in T1/T2's expected footprint; T3–T5 prompts never restate R1/R2.
- [ ] `newId()` helper exists in the seed (so R2 is followable) but is not referenced until T4.

**Verification:**
- [ ] `npm run bench -- --list` shows the campaign without crashing.
- [ ] Manual: a plausible correct T3 solution's diff matches R1's `required`/misses `forbidden`; a drifted one trips `forbidden`.

---

## Task: Campaign trajectory report

```yaml
id: T-camp-report
depends_on: [T-camp-schema]
parallel_safe: true
conflicts_with: []
files_write:
  - src/report.ts
  - src/report.test.ts
branch_suffix: camp-report
scope: M
```

**Description:** Render `Report.campaigns` in report.md + report.json when present (absent ⇒ existing report byte-unchanged). A `## Memory effect (campaign)` section: a per-task trajectory table (task × bundle → ✓/✗ adherence, score, turns) and a headline **cumulative adherence delta** (adhered-count per bundle, memory vs memoryless). Anchors lead; /100 + cost secondary. Degrade gracefully (missing anchor/score → `—`).

**Acceptance:**
- [ ] A Report with `campaigns` renders the trajectory + cumulative delta (md + json).
- [ ] A Report without `campaigns` is unchanged; missing fields don't throw.

**Verification:**
- [ ] `npx tsx --test src/report.test.ts` — fixture CampaignResult(s) → asserts trajectory + delta; absence path unchanged.

---

## Task: Wire the campaign through the orchestrator

```yaml
id: T-camp-wiring
depends_on: [T-camp-runner, T-rule-anchor, T-camp-report]
parallel_safe: true
conflicts_with: []
files_write:
  - src/cli.ts
  - src/cli.test.ts
branch_suffix: camp-wiring
scope: M
```

**Description:** Teach `loadTasks` the `campaign` DTO (resolve each entry's `file` → prompt via `resolveWithin`, carry its `anchor`). Route campaign tasks through `runCampaign`; for EACH returned per-task artifacts, run `judgeRun` (per-task prompt as context) AND `detectAnchor` on that task's rule anchor, assembling a `CampaignResult` (per-task score + anchor + metrics), and write it into `report.campaigns`. Each `(bundle × campaign × model)` cell runs the whole chain in its OWN persistent workspace. Single-pair sequence + single-shot dispatch unchanged. Reuse `judge.ts` as-is.

**Acceptance:**
- [ ] A `campaign` meta loads and dispatches through `runCampaign`; each task judged + anchored; a `CampaignResult` lands in the report.
- [ ] Non-campaign tasks route exactly as today.
- [ ] The three bundles each produce a full 5-task trajectory.

**Verification:**
- [ ] `npx tsx --test src/cli.test.ts` — loader recognizes `campaign`; dispatch routes to a fake runCampaign; per-task judge+anchor assembled. Full suite green.

---

## Task: Integration proof (adhere vs drift)

```yaml
id: T-camp-integration
depends_on: [T-camp-wiring, T-camp-fixture, T-camp-report]
parallel_safe: true
conflicts_with: []
files_write:
  - src/campaign.integration.test.ts
branch_suffix: camp-integration
scope: M
```

**Description:** Offline end-to-end proof (fake executor at the boundary, real `runCampaign` + real `detectAnchor(rule)` + real report render) on the real fixture. A memory-carrying fake records R1/R2 into `.claude/memory` on T1/T2 and applies them on T3–T5 (diff uses `Intl`/`newId()`); a memoryless fake drifts (diff uses `date-fns`/`randomUUID`). Assert: memory adheres on T3/T4/T5 (cumulative 3/3), memoryless drifts (0/3, `hitKnownTrap` set); memory persists across the chain and per-task diffs isolate; the report renders the trajectory + cumulative delta showing the divergence.

**Acceptance:**
- [ ] Memory fake ⇒ 3/3 adhered; memoryless fake ⇒ 0/3 (forbidden markers tripped).
- [ ] Persistence + per-task isolation asserted through the real runner.
- [ ] Rendered report shows the cumulative-delta divergence.

**Verification:**
- [ ] `npx tsx --test src/campaign.integration.test.ts` passes; `npx tsc --noEmit && npm test` green.

---

## Checkpoints

- **Foundation** (after T-camp-runner, T-rule-anchor, T-camp-fixture): human gate — confirm the chain runs with memory persisting, the rule anchor classifies adhere-vs-drift correctly, and the fixture's rules are genuinely non-leaky, BEFORE report/wiring build on top. This is where a 4th null-result risk is caught.
- **Complete** (after T-camp-integration): full suite green; the three bundles produce trajectories; the report shows the memory-vs-memoryless cumulative delta.

## Verification checklist

- [x] `**Status:**` line present (proposed)
- [x] Stable slug ids; acceptance + verification each
- [x] depends_on / parallel_safe / files_write declared
- [x] No two parallel tasks share a files_write path (single-owner → conflicts_with empty)
- [x] Non-empty day-zero ready set: `[T-camp-schema]`
- [x] No scope L; none > 5 files
- [x] DAG matches per-task depends_on
- [x] Checkpoints (Foundation, Complete)
- [ ] Human approval
