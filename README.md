# CLAUDE.md Variant Benchmarking Harness

Measures how well different `CLAUDE.md` system-prompt variants perform on a real
coding task, scored against a fixed rubric by a strong judge model. Turns "which
doctrine feels better" into reproducible, weighted scores out of 100.

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
  4. runJudge          ──▶ docker run claude -p (tools off, prompt over stdin)
                          │        → parse JSON block from response, validate
                          │
  5. applyCapsAndScore ──▶ deterministic total + rubric caps (harness, not judge)
                          │
                 aggregate → reports/<run-folder>/{report.md, report.json, results/}
```

The orchestrator runs on the host via `tsx` (no build step) and shells out to
`docker run` for each container invocation.

## The rubric (weights, out of 100)

| Dimension            | Weight | Focus |
|----------------------|--------|-------|
| Code Quality         | 30     | SOLID, separation of concerns, readability, naming |
| Testing Coverage     | 40     | Real framework + meaningful happy-path & edge tests |
| Security Quality     | 20     | Explicit security review, secure defaults, validation |
| Documentation        | 10     | Docs created/updated as part of the work |

Two caps are enforced by the harness **after** the judge scores (the judge's
arithmetic and totals are never trusted — the harness recomputes them):

- **Testing cap (mechanical/deterministic):** if the task is **logic-bearing**
  and no test file was created/updated (a `*.test.*` / `__tests__/` / test-config
  file — a fact the harness checks directly from the diff), Testing Coverage is
  capped at **10**.
- **Security cap (judge-determined):** if the task is **security-relevant** and
  the judge reports `securityReviewPerformed: false`, Security Quality is capped
  at **8**. "Was a security review performed" is a semantic judgment, not
  mechanically checkable (a keyword scan false-negatived and contradicted the
  judge's own justification), so this signal comes from the judge. If the judge
  omits the field it defaults to `true` (the cap is punitive, so it only fires on
  a positive "no review" signal).

Shape/integer/range validation of the judge's JSON remains the deterministic
trust backstop. Raw judge scores and final (post-cap) scores are both recorded so
the report is transparent about any clamping.

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
npm run bench -- --report reports/<run>/    # regenerate a report from a finished run (offline)
```

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

`--concurrency N` (alias `-c`, default `1`) runs up to N matrix cells
(`executorModel × task × variant`) at once through a bounded worker pool. At
`N=1` the run is fully sequential with live per-line logging — identical to the
default behavior. At `N>1` each cell's log lines are **buffered** and emitted as
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

Each executor run is bounded by `BENCH_EXECUTOR_TIMEOUT_MS` (default 900 s;
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
| `BENCH_EXECUTOR_TIMEOUT_MS` | `900000` | Per-executor-run timeout |
| `BENCH_JUDGE_TIMEOUT_MS` | `300000` | Per-judge-run timeout |
| `BENCH_SETUP_TIMEOUT_MS` | `300000` | Per setup-bundle pre-step timeout |
| `BENCH_CONTAINER_KILL_GRACE_MS` | `10000` | Grace before force-resolving a hung run after timeout |
| `BENCH_INTER_CELL_DELAY_MS` | `0` | Default pause between cells (overridden by `--delay-ms`) |
| `BENCH_MAX_DIFF_BYTES` | `200000` | Byte cap on the diff shown to the judge |
| `BENCH_MAX_TRANSCRIPT_BYTES` | `200000` | Byte cap on the transcript shown to the judge |

### Evidence handling

- **Prompts are sent over stdin**, not as a `-p "<...>"` argv element, so a large
  evidence bundle can never hit the OS `ARG_MAX` limit (`spawn E2BIG`).
- **Dependency/build artifacts are never captured.** Each workspace's
  `.git/info/exclude` ignores `node_modules/`, `dist/`, `build/`, `coverage/`,
  `.next/`, `.turbo/`, `*.log`, `.DS_Store` (and the variant `CLAUDE.md`), so a
  legitimate `npm install` is not counted as the agent's work.
- **Evidence is size-capped.** The redacted diff and transcript are each
  truncated at `BENCH_MAX_DIFF_BYTES` / `BENCH_MAX_TRANSCRIPT_BYTES` before the
  judge sees them, with a visible `[... truncated ...]` marker. Truncation sets
  `evidenceTruncated` on the result and shows a note in the report; it does not
  affect scores. The full redacted diff/transcript are still written to
  `results/<runId>/`.

### Run metrics (cost & time KPIs) — observed, not scored

Each run also records how expensive and slow the variant was to execute. These
are **purely observational** — they never affect scores, caps, or ranking.

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

- **Console** — appended to each run's line, e.g.
  `judged: total 90/100  [exec 78.4s, $0.1234, 45.2k in / 3.1k out, 12 turns]`.
- **`reports/report.md`** — a `## Run metrics (not scored)` table with a
  **Model** column: exec time, exec cost, input/output tokens, turns, judge cost
  per (variant × model). Absent CLI fields render as `—` (never
  `undefined`/`NaN`). Cost/tokens/time are **summed** across each (variant ×
  model)'s tasks (total spend).
- **`<runDir>/report.json`** and each **`<runDir>/results/<cellId>/result.json`**
  — the full raw `metrics` object (executor + judge `CallMetrics`, all fields).

### Report sections

- **Single executor model**: `## Score matrix` (one row per variant), unchanged.
- **Multiple executor models** (`--models`):
  - `## Cross-model comparison (Total /100)` — headline table, rows = variant,
    one column per executor model, `★` marking the best model per variant.
  - `## Per-model score matrices` — the full dimension matrix once per model
    under `### Model: <name>`, ranked within that model.
  - The aggregation unit is `(variant × executorModel)` across tasks — scores
    are **never averaged across models** (they aren't interchangeable). "Top
    result" reports the best `(variant, model)` overall.
- `report.json` keeps a flat `results` array (each entry tagged with
  `executorModel`/`judgeModel`, so it's groupable by model, plus a derived
  `scored` flag / `excludedReason`) plus an `executorModels` list, the fixed
  `judgeModel`, and a `variantSummary` (per-unit `scoredCount`/`attemptedCount`/
  `meanTotal`).

### Scored vs excluded cells (only real verdicts count)

The /100 mean is computed over **scored cells only** — a cell counts iff it
produced a real judge verdict (executor OK **and** no judge failure; timeouts
already fail the executor). This keeps wall-clock (the executor timeout) from
polluting the ranking:

- A failed/timed-out cell is a **coverage gap, never a fabricated 0**. It is
  excluded from the mean, shown as `⚠️ excluded` in the matrix, and listed under
  **`## Excluded cells (not scored)`** with its reason.
- Each matrix row shows **coverage** — e.g. `2/3 scored, 1 excluded`. A unit with
  **zero** scored cells renders `⚠️ excluded` (not `0`) and ranks **last**.
- A genuine judge-scored `0` (present output the judge rated 0) **does** count —
  only the failure path is excluded, never a real verdict.
- Time/cost KPIs are unchanged: they remain observational and still include
  failed/timed-out attempts (honest cost accounting), and never feed the score.

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

The lone-CLAUDE.md variants are designed to produce genuinely different rubric
outcomes so the harness visibly discriminates between doctrines; the bundles
test whether a full skills/agents harness beats a plain prompt.

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
security-relevant, exercising all four rubric dimensions. The task prompt states
the requirement but deliberately does **not** ask for tests or a security review
— that is exactly what the variants influence and the rubric measures.

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
  prompt. This keeps scoring reproducible and prevents the judge from wandering.
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

The harness dogfoods its own rubric: the pure scoring, classification, parsing,
and reporting functions are unit-tested with the zero-dependency `node:test`
runner. Container-dependent code paths (Docker spawn, executor, judge I/O) are
exercised by the real benchmark run.

## Layout

```
Dockerfile              pinned claude CLI image
scripts/                build-image.sh, setup-auth.sh
src/
  config.ts             paths, image, models, weights, timeouts (env-overridable)
  auth.ts               OAuth token resolution (env var → token file)
  types.ts              domain types
  variant.ts            variant.json manifest parse + defaults
  rubric.ts             verbatim rubric, judge prompt + output contract, cap logic
  docker.ts             docker run wrappers (executor, judge, auth probe)
  workspace.ts          per-run workspace prep + git baseline + bundle materialize
  capture.ts            diff, file classification, transcript, signals
  metrics.ts            parse cost/time KPIs from the result event + formatters
  pool.ts               bounded-concurrency worker pool (order-preserving)
  runmeta.ts            per-run GUID folder naming + reverse-time sort key
  executor.ts           run one (variant × task × model) cell
  judge.ts              evidence bundle → judge → parse → cap-enforce
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
