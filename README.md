# CLAUDE.md Variant Benchmarking Harness

Measures how well different `CLAUDE.md` system-prompt variants perform on real
coding tasks, scored on five lexicographic axes — Correctness, Adherence, Craft,
Efficiency, Reliability. Everything that can be measured deterministically is
measured by the harness; a strong judge model scores only the qualitative
residual. Turns "which doctrine feels better" into reproducible, auditable
verdicts — never a weighted mega-score.

Every agent and judge invocation runs through the official `claude` CLI inside a
Docker container that is fully isolated from your real `~/.claude`. No Anthropic
API keys, no direct API calls, no Python.

## How it works

```
                 host (tsx orchestrator)
                          │
      for each (executor model × task × variant):
                          │
  1. prepareWorkspace  ──▶ temp dir, git baseline, drop variant CLAUDE.md
                          │
  2. runExecutor       ──▶ docker run claude -p (tools on, stream-json, --model)
                          │        auth via env var; workspace→/work bind-mount
                          │
  3. captureArtifacts  ──▶ git diff, classify files, extract transcript, signals
                          │
  4. deterministic axes ▶ testCommand run in-container, anchor grading, slop
                          │        metrics, expected-surface scoping (harness)
                          │
  5. runJudge          ──▶ docker run claude -p (tools off, prompt over stdin)
                          │        diff + read-only deterministic context → strict
                          │        JSON (craft, blast radius, correctness fallback)
                          │
  6. pairwise judging  ──▶ A/B craft comparisons per variant pair (on by default)
                          │
                 aggregate → reports/<run-folder>/{report.md, report.json, results/}
```

The orchestrator runs on the host via `tsx` (no build step) and shells out to
`docker run` for each container invocation.

## The five axes

**The judge only scores what cannot be measured deterministically.** Correctness
(tests), adherence (anchors), efficiency (telemetry), and reliability (cross-run
variance) are computed by the harness and handed to the judge as read-only
context. The judge owns three things: the qualitative residual of Craft, intent
classification for Blast Radius, and a fail-closed correctness assessment ONLY
when no executable check exists.

| Axis | Source | Judge role |
|------|--------|------------|
| **Correctness** | the task's optional `testCommand`, run in the workspace container after the executor finishes (pass = exit 0) | fallback verdict (`likely_correct` / `likely_incorrect` / `unknown`) only when the task declares no tests; fail-closed |
| **Adherence** | graded anchors — `held-by-abstraction` > `held-by-literal` > `held-by-inertia` > `drift` > `trap` (harness, deterministic) | none — read-only context |
| **Craft** | deterministic slop metrics (duplication windows, churn ratio, residue, test-tamper grep) + judge residual: naming / structure / consistency / economy, each 0–4 ordinal with cited evidence | scores the qualitative residual only |
| **Efficiency** | tokens, turns, wall-clock, cost (telemetry) | none |
| **Reliability** | cross-run variance via `--repeats N` | none |

Reporting is **lexicographic, never a weighted mega-score**:

1. **Correctness gates everything.** A failing `testCommand` is a failing cell —
   no amount of craft polish outranks it.
2. **Adherence is the campaign headline** — did the convention hold, and *how*.
3. **Craft** = slop deltas + judge medians + pairwise win-rates. Cross-bundle
   ranking uses A/B pairwise judging with randomized assignment and a
   position-bias audit — **absolute craft scores are never compared across
   bundles**.
4. **Efficiency** and **Reliability** are reported columns.

### Correctness

A task (or campaign link) may declare a `testCommand` in its `meta.json`; the
harness runs it in the workspace container after the executor finishes
(`BENCH_TEST_TIMEOUT_MS`, default 300 s) and the exit code is the verdict.
Pass/fail counts are parsed best-effort from node:test / jest / vitest output —
the exit code stays authoritative, counts are never fabricated. Campaign links
may carry per-link `testCommand`s, since later links accrete code and typically
need a wider command than earlier ones.

When no `testCommand` exists, the judge supplies a deliberately hedged fallback
verdict: `likely_correct` / `likely_incorrect` / `unknown`, based solely on
reading the diff against the task. When in doubt it must say `unknown` — a
static read of a diff is not a test run, and downstream reporting weights it
accordingly.

### Adherence — graded anchors

Anchors are deterministic detectors (no judge involvement) over the run's diff
and trace. The graded detector refines "did the convention hold" into *how*:

- **`held-by-abstraction`** — the required signals are absent from this link's
  own diff but present in the cumulative chain diff: the convention persists via
  a helper built earlier in the chain (campaign mode). The strongest hold.
- **`held-by-literal`** — the convention was re-emitted literally in this link's
  own diff.
- **`held-by-inertia`** — the link never exercised the rule's surface: none of
  the rule's `appliesIf` regexes matched its diff, so the hold is vacuous, not
  earned.
- **`drift`** — the link added real code but the required signals are absent.
- **`trap`** — a forbidden signal is present in the link's own diff.
- **`unknown`** — fail-closed when the detector cannot grade (no added lines,
  malformed rule pattern).

For `rule` anchors the precedence is exact: trap → literal → inertia →
abstraction → drift/unknown. Inertia is checked *before* abstraction so a link
that never faced the rule can't be spuriously credited via the cumulative diff,
and forbidden signals are only ever tested against the link's own diff — a
marker inherited from an earlier link doesn't poison this link's grade.

### Craft — mechanical slop + judged residual

The mechanical half is computed by the harness from the diff (pure string
functions — the numbers can't be argued with, and a reader can re-derive any
count by hand):

- **`duplicationDelta`** — duplicated 4-line added-line windows
  (whitespace-normalized, never straddling a file boundary, brace/import noise
  filtered); N identical windows count as N−1.
- **`churnRatio`** — campaign links only: the fraction of lines added by earlier
  links that this link deletes — high churn means the chain is rewriting its own
  work. `null` for single-shot cells (not measurable, never a fake clean 0).
- **`residue`** — shipped work-in-progress: TODO/FIXME markers, debug logging
  (`console.log`/`debugger`), commented-out code — counted on added lines only.
- **`testTamper`** — signals that the run weakened tests to pass: added
  `.skip(` / `.only(` / `xit(` / `xdescribe(` / `test.todo(` / `eslint-disable` /
  `@ts-nocheck` / `--passWithNoTests`, plus deleted `expect(`/`assert` lines —
  each hit quoted as evidence.

The judge scores only the residual — four dimensions, each on a 0–4 ordinal
scale (definitions, not vibes):

- **0 — actively harmful** (misleading names, structure that hides a bug,
  copy-paste divergence waiting to happen)
- **1 — poor** (works, but a maintainer would rewrite it)
- **2 — acceptable** (unremarkable, no objections in review)
- **3 — good** (a reviewer would approve without comments)
- **4 — exemplary** (the solution a strong senior engineer would write;
  teachable)

Dimensions: **naming** (identifiers communicate intent), **structure**
(right-sized functions/modules — both under-abstraction and speculative
over-abstraction are penalized), **consistency** (matches the surrounding repo's
idioms, judged against the seed code visible in diff context lines), and
**economy** (the diff is proportionate to the task; no drive-by rewrites, no
padding, no dead code). Every score must cite `file:line — quote` evidence from
the diff (quotes capped at 10 words); a score without evidence is invalid and
recorded as `unknown`. The judge is explicitly told to judge the diff, not the
agent's narration; verbosity is not rewarded and brevity is not penalized.

### Craft across bundles — pairwise A/B judging

Absolute craft scores drift across judge calls and are not comparable across
agent configurations, so cross-bundle ranking comes from pairwise win-rates
instead: for each variant pair on the same (task/link × executor model ×
repeat), a second judge call compares the two diffs head-to-head per craft
dimension plus an overall verdict. The A/B assignment is randomized per call to
cancel position bias, the resolved mapping is recorded so winners always map
back to variant names, and the report carries a position-bias audit. `tie` is a
legitimate and expected verdict; a judge failure degrades to all-tie (a dead
judge can never move rankings). On by default — disable with `--no-pairwise` /
`BENCH_PAIRWISE=0` to halve judge cost on exploratory runs.

### Blast radius (`expectedSurface`)

A task — or an individual campaign link, whose declaration overrides the task's
wholesale, never merged — may declare `expectedSurface`: glob patterns of the
files the agent is expected to touch. The harness mechanically lists every
changed file matching no pattern; the judge only classifies each excursion — it
never decides what counts as out-of-scope:

- **`necessary`** — the task could not be completed without it
- **`defensible`** — not required, but a reasonable reviewer would accept it
- **`overreach`** — unrequested change with no task justification
- **`adversarial`** — weakens a check to make the task appear complete
  (test-expectation edits, disabled lint rules, skipped tests, loosened
  assertions); must quote the exact weakened check

Any single `adversarial` classification **hard-disqualifies the cell**: it is
excluded from every aggregate and reported — a gaming attempt must never be
averaged away. An absent `expectedSurface` means scoping is off for that task
(deliberately fail-open: scoping is opt-in per fixture); an explicit `[]` means
"this run may touch nothing", so every touched file is out of scope.

### Fail-closed judge contract

- **The judge sees the DIFF only, never the transcript.** Transcripts are
  provider-fingerprinted (they leak which harness produced them), so craft is
  judged from the diff alone. The deterministic context (anchor verdict, test
  results, slop metrics, out-of-scope files) is rendered read-only in the
  prompt; the judge is instructed not to re-derive or dispute it.
- **Strict JSON output.** A parse failure triggers exactly one re-ask with the
  raw output quoted back plus "Output valid JSON only."; a second failure
  records the judge's fields as `unknown`/empty — the deterministic axes
  survive intact.
- **Out-of-range values are never clamped.** A craft score outside 0–4, or a
  numeric score with no cited evidence, becomes `unknown` with a visible
  `invalid:*` flag — a judge malfunction must not masquerade as a real low
  score. Malformed blast-radius entries are dropped (flagged); an invalid
  correctness verdict degrades to `unknown`.
- **Evidence is capped** — 10 words per quoted snippet in-prompt, 120 chars
  kept at parse — so verdicts stay auditable without republishing the diff.
- **Truncation fails closed.** The diff embedded in the judge prompt is
  byte-capped (`BENCH_MAX_DIFF_BYTES`) with a visible `[DIFF TRUNCATED]`
  marker, and the prompt's own rule tells the judge to output `unknown` for
  anything it cannot see.

### Task metadata that feeds the axes (`meta.json`)

- **`testCommand`** — arms the deterministic Correctness axis; campaign links
  may carry per-link overrides.
- **`expectedSurface`** — arms blast-radius scoping; a campaign link's
  declaration replaces the task-level one wholesale.
- **`appliesIf`** (on `rule` anchors) — regexes describing the code surface that
  exercises the rule; when none match a link's diff the grade is
  `held-by-inertia` (vacuous hold) instead of a credited literal/abstraction
  hold. Omitted = applicability unknown; grading falls back to the
  required/forbidden signals alone.

## Setup

Prerequisites: Docker Desktop and Node 22.

```bash
npm install                 # dev deps only (tsx, typescript, @types/node)
npm run build-image         # builds claude-bench:latest
npm run setup-auth          # ONE-TIME interactive login (see below)
```

### One-time auth (token model)

`claude setup-token` (requires a Claude subscription) **prints** a long-lived
subscription token to the terminal — it does not persist a credential file.
Headless/Docker runs supply that token via the `CLAUDE_CODE_OAUTH_TOKEN` env var.

`npm run setup-auth` walks you through it: it runs `claude setup-token`
interactively in the image (a browser opens to authorize; if it shows a code
instead of redirecting, paste that code at the prompt), then asks you to paste
the printed token back. The token is stored at `./.bench-config/oauth-token`
(chmod 600, gitignored) and is never echoed back. This is interactive and must
be run by you.

The harness resolves the token in this order:

1. `CLAUDE_CODE_OAUTH_TOKEN` if exported (in which case you can skip
   `setup-auth` entirely), then
2. the `./.bench-config/oauth-token` file.

Every container run receives the token as an env var. No credential file is ever
mounted into a container, and the real `~/.claude` / macOS keychain is never
touched.

## Usage

```bash
npm run bench -- --list                    # list variants + tasks (no auth needed)
npm run bench -- --all                      # full matrix: every variant × every task
npm run bench -- --variant tdd-first        # one variant
npm run bench -- --variant minimal --variant security-first
npm run bench -- --task safe-redirect       # restrict to one task
npm run bench -- --all --models fable,sonnet,opus   # compare across executor models
npm run bench -- --all --concurrency 3      # run up to 3 cells in parallel
npm run bench -- --all --delay-ms 5000      # pace cells to ease rate limits
npm run bench -- --all --repeats 3          # run each cell 3× (Reliability: cross-run variance)
npm run bench -- --all --no-pairwise        # skip A/B craft judging (halves judge cost)
npm run bench -- --report reports/<run>/    # regenerate a report from a finished run (offline)
npm run bench -- --report reports/<run>/ --focus craft   # focused re-render: one concern only
```

### Focused reports: `--focus <axis>`

`--focus <axis>` renders a **focused report** — only the named concern's
section(s) plus the run header — instead of the full multi-axis report. Handy
when iterating on one dimension (e.g. tuning a CLAUDE.md's craft or memory
doctrine) without scrolling past the other axes. Accepted axes:

| `--focus` | Renders |
| --- | --- |
| `correctness` | Correctness table |
| `memory` | Memory effect (single-shot and/or campaign) |
| `craft` | Slop, judge craft, pairwise, Craft Score |
| `efficiency` | Cost / time / turns table |
| `blast-radius` | Out-of-scope file excursions |

An unknown axis fails fast with the accepted set enumerated. The cross-task
insight callout and the observational tails (Reliability, Excluded cells,
Behavioral signals) are full-report only and are dropped in a focused render.
`report.json` is always the complete payload — `--focus` only narrows the
rendered `report.md`, so it composes with `--report` for an offline re-render.

### The benchmark matrix: variant × task × executor model

The executor model is a first-class dimension. `--models <csv>` (comma/space
separated, repeatable) runs each selected (variant × task) against each executor
model, so you can compare how a CLAUDE.md doctrine performs on e.g. Fable vs
Opus vs Sonnet. Without `--models`, a single model (`BENCH_EXECUTOR_MODEL`,
default `sonnet`) is used — behavior is identical to before.

Model aliases: `fable`, `opus`, `sonnet`, `haiku`.

**The judge model is held FIXED** (`BENCH_JUDGE_MODEL`, default `opus`) across
every run. Varying the judge would make scores non-comparable, so only the
executor varies; every result is tagged with both `executorModel` and the fixed
`judgeModel`. Preflight probes auth for each distinct executor model plus the
judge model.

### Concurrency

`--concurrency N` (alias `-c`, default `3`, or `BENCH_CONCURRENCY`) runs up to
N matrix cells (`executorModel × task × variant`) at once through a bounded
worker pool. At `N=1` the run is fully sequential with live per-line logging.
At `N>1` each cell's log lines are **buffered** and emitted as
one contiguous block with a `[k/total]` progress counter, so concurrent cells
stay readable instead of interleaving.

The report is sorted deterministically (executor model → variant → task) before
rendering, so output is stable regardless of `N`.

Tradeoffs: higher N trims wall-clock but multiplies CPU/RAM pressure from
concurrent resource-heavy executor containers (each may run `npm install`, build,
test) and raises the chance of transient API rate-limit/overload responses —
which the existing retry-with-backoff absorbs. `2`–`3` is a sane range; values
above `16` are clamped. Invalid or `< 1` values are rejected with a clear error.

### Timeouts

Each executor run is bounded by `BENCH_EXECUTOR_TIMEOUT_MS` (default 1800 s;
judge by `BENCH_JUDGE_TIMEOUT_MS`, default 300 s). Enforcement is authoritative:
on timeout the harness `docker kill`s the container **and** SIGKILLs the local
`docker run` client, and if the client still hasn't exited within a grace window
(`BENCH_CONTAINER_KILL_GRACE_MS`, default 10 s) the run is force-resolved as
timed-out. This caps a run's wall-clock at ≈ timeout + grace — earlier a hung,
rate-limited client lingered ~14 minutes past the kill.

**A timeout is terminal for that cell — it is NOT retried.** A timeout almost
always means the session hung (usually API rate-limiting), so a retry would just
burn another full timeout; the cell is recorded as failed and the matrix moves
on. Genuine transient failures (spawn error, non-timeout non-zero exit) still
retry with backoff.

### Rate limits

Sustained large matrices — especially many Opus cells back-to-back — can hit
subscription rate limits. The symptom is executor runs that stall (the trace
shows repeated `api_retry` events) and eventually hit the timeout. Mitigate by:

- running smaller `--models` batches,
- adding `--delay-ms N` (default 0) to pause N ms between cells — both
  sequentially and before each pool dispatch — easing sustained pressure, and/or
- lowering `--concurrency`.

Before running the matrix, the CLI performs a preflight auth probe in a
container. If it is not logged in, it prints instructions to run
`npm run setup-auth` and exits non-zero — it never tries to auth for you.

### Output: durable, never-overwritten per-run folders

Every `bench` invocation gets a **GUID `runId`** (`crypto.randomUUID()`) and its
own self-contained folder under `reports/` — the report and all cell results
live together, and no run ever overwrites another:

```
reports/
  <revkey>__<iso>__<short8>/
    report.md            # includes the full runId GUID in its header
    report.json          # meta.runId = full GUID
    results/
      <cellId>/          # cellId = task__variant__modelSlug (unique within a run)
        diff.patch  trace.ndjson  transcript.txt  result.json  workspace/
```

- **`<revkey>`** is a fixed-width, zero-padded **reverse-time key**
  (`HORIZON_MS - runEpochMs`). A newer run yields a *smaller* number, so a plain
  ascending name sort (the default in most tools) lists the **newest run first**.
  The leading segment is deliberately this sort key, not a readable date — the
  human-readable UTC stamp follows it.
- **`<iso>`** is a filesystem-safe UTC stamp (`2026-07-08T15-30-00Z`).
- **`<short8>`** is the first 8 hex of the GUID for a readable folder name; the
  full GUID is in `report.json` and the `report.md` header.

Two ids, disambiguated:
- **`runId`** — the per-execution GUID (one per `bench` invocation / whole matrix).
- **`cellId`** — the per-(variant × task × model) id, `task__variant__modelSlug`,
  unique within a run (no timestamp needed).

`reports/` is gitignored.

### Environment overrides

| Variable | Default | Meaning |
|----------|---------|---------|
| `BENCH_IMAGE` | `claude-bench:latest` | Docker image tag |
| `BENCH_EXECUTOR_MODEL` | `sonnet` | Model that does the coding |
| `BENCH_JUDGE_MODEL` | `opus` | Model that scores |
| `BENCH_EXECUTOR_TIMEOUT_MS` | `1800000` | Per-executor-run timeout |
| `BENCH_CONCURRENCY` | `3` | Default cell concurrency (overridden by `--concurrency`) |
| `BENCH_JUDGE_TIMEOUT_MS` | `300000` | Per-judge-run timeout |
| `BENCH_TEST_TIMEOUT_MS` | `300000` | Timeout for a task's `testCommand` container (Correctness axis) |
| `BENCH_SETUP_TIMEOUT_MS` | `300000` | Per setup-bundle pre-step timeout |
| `BENCH_CONTAINER_KILL_GRACE_MS` | `10000` | Grace before force-resolving a hung run after timeout |
| `BENCH_INTER_CELL_DELAY_MS` | `0` | Default pause between cells (overridden by `--delay-ms`) |
| `BENCH_PAIRWISE` | on | Pairwise A/B craft judging; only `0`/`false` disable (any other value, including a typo, stays on). Overridden by `--no-pairwise` |
| `BENCH_REPEATS` | `1` | Runs per (variant × task × model) cell (Reliability axis). Overridden by `--repeats N` |
| `BENCH_MAX_DIFF_BYTES` | `200000` | Byte cap on the diff shown to the judge |
| `BENCH_MAX_TRANSCRIPT_BYTES` | `200000` | Byte cap on the captured transcript (artifact only — the judge never sees it) |

### Evidence handling

- **Prompts are sent over stdin**, not as a `-p "<...>"` argv element, so a large
  evidence bundle can never hit the OS `ARG_MAX` limit (`spawn E2BIG`).
- **Dependency/build artifacts are never captured.** Each workspace's
  `.git/info/exclude` ignores `node_modules/`, `dist/`, `build/`, `coverage/`,
  `.next/`, `.turbo/`, `*.log`, `.DS_Store` (and the variant `CLAUDE.md`), so a
  legitimate `npm install` is not counted as the agent's work.
- **Evidence is size-capped.** The redacted diff is truncated at
  `BENCH_MAX_DIFF_BYTES` before the judge sees it, with a visible truncation
  marker — and a truncated diff triggers the judge's own fail-closed rule
  (output `unknown` for anything it cannot see). The transcript — which the
  judge never sees — is still captured, redacted, and capped at
  `BENCH_MAX_TRANSCRIPT_BYTES` as an artifact. Truncation sets
  `evidenceTruncated` on the result and shows a note in the report. The full
  redacted diff/transcript are still written to `results/<runId>/`.

### Run metrics (cost & time KPIs) — the Efficiency axis

Each run also records how expensive and slow the variant was to execute. These
remain **observational per cell** and now surface as the **Efficiency axis** —
a reported column, still never folded into the other axes or their ranking.

- **Wall-clock time** (headline): host-measured around the whole `docker run`
  (spawn → exit), so it includes container startup, `npm install`, etc. — the
  truest "actual time spent". The CLI's own `duration_ms` (agent-session time)
  and `duration_api_ms` are captured too.
- **Cost**: `total_cost_usd` from the claude result event. On a subscription
  this is the *would-be* API cost — a useful proxy, not an actual charge. The
  **token counts** (`input`/`output`, plus cache read/create) are the ground
  truth, so both are captured.
- **Turns**: the agent's `num_turns`.

Both the executor and judge calls are measured. Where they appear:

- **Console** — appended to each cell's judged log line, alongside that cell's
  craft summary and anchor grade: exec wall time, cost, tokens in/out, turns.
- **`reports/report.md`** — the Efficiency section: a per-(variant × model)
  table with exec time, exec cost, input/output tokens, turns, judge cost.
  Absent CLI fields render as `—` (never `undefined`/`NaN`). Cost/tokens/time
  are **summed** across each (variant × model)'s tasks (total spend).
- **`<runDir>/report.json`** and each **`<runDir>/results/<cellId>/result.json`**
  — the full raw `metrics` object (executor + judge `CallMetrics`, all fields).

### Report sections

`report.md` walks the axes in lexicographic order — the same priority the
scoring uses:

- **Correctness** — per-cell `testCommand` verdicts (pass/fail, plus parsed test
  counts when the runner output was parseable); cells without executable tests
  show the judge's hedged fallback verdict instead.
- **Memory effect** (adherence) — the campaign headline: graded anchor verdicts,
  rendered with graded symbols — `✓A` held-by-abstraction, `✓L` held-by-literal,
  `~I` held-by-inertia, `✗` drift, `⚠` trap, `?` unknown.
- **Craft** — the slop-metrics table, per-cell judge craft medians, and pairwise
  win-rates with the position-bias audit. Absolute craft medians are comparable
  only within a bundle; cross-bundle ranking reads the win-rates.
- **Efficiency** — cost/time/token columns per (variant × model).
- **Reliability** — cross-run variance when `--repeats N` > 1.
- **Blast radius** — out-of-scope touches with the judge's classification;
  adversarial entries are called out with the cell's disqualification.
- Behavior comparison and **`## Excluded cells (not scored)`** — as before.

Multi-model runs (`--models`) group each section per executor model. The
aggregation unit is `(variant × executorModel)` across tasks — axis values are
**never averaged or ranked across models** (they aren't interchangeable), and
pairwise comparisons never cross models either.

`report.json` keeps a flat `results` array (each entry tagged with
`executorModel`/`judgeModel`, so it's groupable by model, plus a derived
`scored` flag / `excludedReason`), an `executorModels` list, and the fixed
`judgeModel`; runs that exercised campaigns or pairwise judging additionally
carry `campaigns` (per-link trajectories) and `pairwise` (A/B comparisons)
arrays.

### Scored vs excluded cells (only real verdicts count)

Aggregates are computed over **scored cells only** — a cell counts iff it
produced a real judge verdict (executor OK **and** no judge failure; timeouts
already fail the executor). This keeps wall-clock (the executor timeout) from
polluting the ranking:

- A failed/timed-out cell is a **coverage gap, never a fabricated
  bottom-of-scale verdict**. It is excluded from every aggregate and listed
  under **`## Excluded cells (not scored)`** with its reason.
- Per-unit **coverage** is reported — e.g. `2/3 scored, 1 excluded`. A unit with
  **zero** scored cells reads as excluded, never as a real verdict, and ranks
  **last**.
- A genuine judged verdict — however unflattering — **does** count: only the
  failure path is excluded, never a real verdict.
- Disqualified cells (any `adversarial` blast-radius entry) are likewise
  excluded from every aggregate and reported — gaming is surfaced, never
  averaged away.
- Time/cost KPIs are unchanged: Efficiency remains observational, still includes
  failed/timed-out attempts (honest cost accounting), and never feeds the other
  axes.

### Regenerating a report (`--report`, offline)

`npm run bench -- --report <path>` rebuilds `report.md` + `report.json` from a
finished run — `<path>` is a run folder (containing `report.json`) or a
`report.json` directly. It reloads the saved results, re-runs the current
aggregation + rendering, and rewrites both files in place. Pure and offline: no
Docker, no auth, no executor/judge calls — so historical runs can be
re-aggregated after a methodology change like this one.

## Variant types

A variant is a `prompts/<name>/` directory. Its shape is declared by an optional
`variant.json` manifest — absent ⇒ `claude-md` (today's behavior):

```jsonc
{
  "type": "claude-md" | "bundle",   // default "claude-md"
  "claudeMd": "CLAUDE.md",           // CLAUDE.md filename within the dir
  "configDir": "claude",             // .claude tree dirname (copy bundles)
  "install": "copy" | "setup",       // bundles only; default "copy"
  "setupCommand": "…",               // required when install="setup"
  "description": "…"                 // shown in --list
}
```

- **`claude-md`** — a lone `CLAUDE.md`. Its content is written to
  `<workspace>/CLAUDE.md`. (An empty file — the `naked` variant — models an empty
  project memory.)
- **`bundle`** — a `CLAUDE.md` PLUS a `.claude/` tree of skills/agents/commands/
  hooks/settings, installed at **project scope** (`<workspace>/.claude/`, where
  Claude Code reads them). Two install modes:
  - **`install: "copy"`** (default, e.g. `agentic-os`) — a vendored
    `.claude/` tree (`configDir`, e.g. `prompts/<name>/claude/`) is copied in and
    every shipped `*.sh` is `chmod +x`ed so hooks run.
  - **`install: "setup"`** (e.g. `gstack`) — the bundle ships no vendored
    `.claude/`; instead its source is **baked into the image** and a
    `setupCommand` registers the skills at runtime. Before the executor runs, the
    harness injects the CLAUDE.md, then runs a **setup pre-step container**
    (mounting `/work`, executing `setupCommand`) that populates
    `<workspace>/.claude/skills`. Its output is saved to `results/<cellId>/setup.log`.
    If the pre-step leaves `.claude/skills` empty, the cell is recorded as failed
    ("bundle setup failed") and the judge is skipped — the matrix continues.
- **Diff isolation:** for every bundle, both `CLAUDE.md` and the entire
  `.claude/` tree are added to the workspace's `.git/info/exclude`, so none of the
  shipped/registered config (skills, agents, hooks) appears in the captured diff
  or `changedFiles` — only the agent's own work is scored.

### Variants shipped

- `naked` — empty `CLAUDE.md` (baseline: no guidance at all).
- `minimal` — almost no guidance.
- `senior-verbose` — clean architecture / SOLID / readability; no testing or
  security mandate.
- `tdd-first` — mandates a real testing framework and thorough tests.
- `security-first` — mandates an explicit security review, threat modeling,
  secure defaults, and docs.
- `agentic-os` — **copy bundle**: the full agentic-os v3.0.1 harness
  ([github.com/LazyIsEfficient/agentic-os](https://github.com/LazyIsEfficient/agentic-os))
  — CLAUDE.md + a vendored `.claude/` (38 skills, agents, commands, hooks, rules,
  settings), copied in at project scope.
- `gstack` — **setup bundle**: Garry's Stack 1.58.5.0 `@11de390`
  ([github.com/garrytan/gstack](https://github.com/garrytan/gstack)) — Bun-native.
  Its source is baked into the image at `/opt/gstack`; a runtime `setup --local`
  registers **55 skills** into `<workspace>/.claude/skills` before the executor
  runs.

The lone-CLAUDE.md variants are designed to produce genuinely different outcomes
across the axes so the harness visibly discriminates between doctrines; the
bundles test whether a full skills/agents harness beats a plain prompt.

### Bundle caveats

- **Cost & latency.** Bundles that dispatch subagents (agentic-os leans on the
  Task tool) multiply API calls per cell → far higher cost/latency and much more
  rate-limit exposure. Prefer low `--concurrency`, `--delay-ms`, and small
  `--models` batches when benchmarking bundles.
- **Global-path hooks/scripts.** A bundle's hooks/scripts that assume a global
  `~/.claude` (or a `~/.cursor`) path won't resolve under a project-scope install
  and may no-op. For agentic-os v3.0.1 the auto-run hooks in `settings.json` are
  all project-relative (`bash .claude/hooks/*.sh`) and self-contained, so they
  run; but some **agent/command instruction docs** reference repo-root
  `scripts/*.sh` and a `$HOME/.cursor/.../ledger.py` findings-ledger that do not
  exist at project scope — if an agent tries to invoke those they will fail/no-op
  (a benign degradation, not a correctness issue). Repo-root `scripts/` is
  deliberately NOT vendored because no hook references it.
- **v3.0.1 memory loop — write hook needs `jq` (now in the image), read hook
  doesn't.** agentic-os **writes** durable facts via a `Stop` hook
  (`.claude/hooks/memory-extract.sh`, the `memory-extraction` skill) — the fix for
  upstream issue #217 — and, as of v3.0.1, **reads them back** via a `SessionStart`
  hook (`.claude/hooks/memory-inject.sh`) that injects the `.claude/memory/MEMORY.md`
  index into each fresh session — the fix for issue #225. The write hook is
  **fail-open on `jq`**: with no `jq` on `PATH` it emits `{}` and silently no-ops, so
  the benchmark `Dockerfile` installs `jq`; strip it and recording stops. The read
  hook needs no `jq` (grep + cat). In **campaign mode** (where `.claude/memory/`
  persists across the chain) these two hooks together are what let a convention
  recorded in one link actually influence a later, context-reset link.
- **MCP-dependent skills.** Skills that rely on MCP servers are unavailable
  inside the container.

### gstack setup bundle — image & fidelity notes

- **Bun + baked G-Stack.** The image installs Bun 1.3.10 and bakes a *built*
  G-Stack at `/opt/gstack` (`bun install && bun run build`). The build must run
  on the image's own filesystem — `bun run build` fails over the macOS Docker
  bind-mount (virtiofs `rename ENOENT`) — so G-Stack is never built in `/work`.
  `/opt/gstack/bin` is on `PATH` so its tools (browse, make-pdf) resolve.
- **Image size.** Bun, G-Stack's `node_modules`, the ~101 MB `browse` binary, and
  a baked Playwright Chromium + its host libs grow the image substantially
  (multiple GB). All variants share this one image; `naked`/`agentic-os`/
  claude-md variants are functionally unaffected (G-Stack skills are only
  registered for the `gstack` variant's cells).
- **Chromium is required for setup.** G-Stack's `setup` hard-gates on a
  launchable Playwright Chromium under `set -e` (it aborts before registering
  skills otherwise), and it honors `GSTACK_SKIP_FONTS`/`GSTACK_SKIP_COREUTILS`/
  `GSTACK_SKIP_GBRAIN_REGEN` (all set `=1` in the image) but has **no** flag to
  skip the browser check. So Chromium + its apt libs are baked in; with them
  present, `setup --local -q --no-prefix` exits 0 and registers 55 skills.
- **Fidelity boundary.** Core skills and the Bun toolchain work in-container.
  Browser/Chrome-driven skills are only partially functional (headless Chromium
  is present, but full browser automation in a container is not validated here),
  and any skill needing external services/MCP is unavailable.

## The task

`tasks/safe-redirect` — implement `resolveSafeRedirect(userSuppliedUrl,
allowlist)` that prevents open redirects (allowlisted scheme/host, rejects
`javascript:`/`data:`/protocol-relative/credentials-in-URL, normalizes relative
paths) plus a small Express-style handler. It is logic-bearing and
security-relevant. The task prompt states the requirement but deliberately does
**not** ask for tests or a security review — that is exactly what the variants
influence and the axes measure.

## Security & isolation model

- **Auth is a single env var — no credential file is mounted.** Every container
  run receives `CLAUDE_CODE_OAUTH_TOKEN` as an env var (resolved from the host
  env or `./.bench-config/oauth-token`). Nothing from the host is bind-mounted
  for auth. The container keeps its own image-provided writable `/cfg`, which is
  ephemeral and discarded by `--rm`.
- **What IS bind-mounted:** only a fresh per-run workspace dir → `/work`
  (read-write), so the host can read the resulting `git diff` after the
  container exits. Nothing else.
- **What is NEVER mounted or read:** your real `~/.claude` and the macOS
  keychain. Isolation is enforced by Docker plus a scoped env var, not by host
  config. A container with no token reports "Not logged in", which is how the
  preflight probe validates auth.
- **`--dangerously-skip-permissions`** is passed to the *executor* so the agent
  can work unattended — but only ever **inside the container**, against a
  throwaway workspace. It is never used on the host.
- **The judge runs with `--tools ""`** (all tools disabled). It cannot read
  files or run commands; it only reasons over the evidence embedded in its
  prompt — the diff plus read-only deterministic context, never the transcript.
  This keeps scoring reproducible and prevents the judge from wandering.
- **`--no-session-persistence`** (executor) keeps runs from leaking state into
  each other.
- The variant `CLAUDE.md` is dropped into the workspace *after* the git baseline
  commit and registered in `.git/info/exclude`, so it is visible to the agent as
  its system prompt but never counted as the agent's own work in the diff.
- **Defense in depth around the token:** before any captured artifact
  (`diff.patch`, `transcript.txt`) is written to the host `results/` dir, a
  redaction pass replaces any occurrence of the OAuth token with
  `[REDACTED-CREDENTIAL]`. The token is only ever held in-memory for this
  comparison — never logged or persisted anywhere else.
- **Known limitation — the executor's agent can read its own token.** The token
  is delivered as an env var to the executor container, so the benchmarked agent
  can read `CLAUDE_CODE_OAUTH_TOKEN` from its environment. This is inherent to the
  headless subscription model (the agent needs the token to call the API). It is
  acceptable here because you are benchmarking your own prompts and the token is
  user-revocable (`claude setup-token` can re-issue). Results redaction stops the
  token from being persisted to disk, but only run variants and tasks you trust.
- **Known limitation — network egress is open.** Containers need outbound network
  to reach the Anthropic API, so egress is not restricted. A hostile task or
  variant in the executor could attempt to exfiltrate over the wire. Locking
  egress to the API endpoints (an egress proxy or firewalled Docker network)
  would close the gap if needed.

## Development

```bash
npm run typecheck    # tsc --noEmit
npm test             # node --test on the pure-function unit tests
```

The harness dogfoods its own scoring: the pure functions behind the axes — slop
metrics, anchor grading, surface scoping, judge-output parsing, classification,
reporting — are unit-tested with the zero-dependency `node:test` runner.
Container-dependent code paths (Docker spawn, executor, judge I/O) are exercised
by the real benchmark run.

## Layout

```
Dockerfile              pinned claude CLI image
scripts/                build-image.sh, setup-auth.sh
src/
  config.ts             paths, image, models, timeouts, scoring toggles (env-overridable)
  auth.ts               OAuth token resolution (env var → token file)
  types.ts              domain types
  variant.ts            variant.json manifest parse + defaults
  rubric.ts             cell-judge prompt (craft/blast/correctness residual) + output contract
  docker.ts             docker run wrappers (executor, judge, auth probe)
  workspace.ts          per-run workspace prep + git baseline + bundle materialize
  capture.ts            diff, file classification, transcript, signals
  anchors.ts            deterministic anchor detectors + graded verdicts (Adherence)
  slop.ts               mechanical slop metrics over the diff (Craft, deterministic half)
  surface.ts            expectedSurface glob scoping (blast radius, deterministic half)
  metrics.ts            parse cost/time KPIs from the result event + formatters
  pool.ts               bounded-concurrency worker pool (order-preserving)
  runmeta.ts            per-run GUID folder naming + reverse-time sort key
  executor.ts           run one (variant × task × model) cell
  judge.ts              evidence → cell judge → fail-closed parse → verdict
  pairwise.ts           A/B craft comparisons (randomized order, fail-closed ties)
  report.ts             markdown + JSON aggregation
  cli.ts                arg parsing, preflight, orchestration
prompts/                variants under test — claude-md dirs + bundle dirs
  <name>/CLAUDE.md      lone-CLAUDE.md variant (or a bundle's injected doctrine)
  <name>/variant.json   optional manifest (declares bundle + install mode)
  <name>/claude/        vendored .claude tree (copy bundles: skills/agents/hooks/…)
  gstack/gstack-src/    G-Stack source, COPY'd to /opt/gstack + built in the image
tasks/                  the benchmark task(s)
reports/                generated per-run folders (gitignored)
```
