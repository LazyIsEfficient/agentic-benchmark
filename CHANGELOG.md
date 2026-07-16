# Changelog

All notable changes to the CLAUDE.md variant benchmark. Releases are labeled
`v0.x` (project milestones); `package.json` semver is independent.

## v0.3 — Craft & Blast-Radius axes, reliability, and honest scoring

v0.3 adds two new scoring axes (**Craft**, **Blast radius**), matures the
pairwise craft judge into a signal you can trust at small samples, makes
deterministic correctness real, and hardens the whole pipeline against the ways
it can quietly lie. **18 PRs since v0.2.**

Design throughline: every scoring input is **deterministic and diff-derivable**
(re-derivable by hand from the saved diff) or a **fail-closed** judge call that
degrades to a tie/unknown — never a fabricated preference. The harness persists
each cell's diff, so slop/craft can be recomputed offline from a finished run
with no rerun.

### New scoring axes
- **Craft axis** — deterministic "slop" metrics over the diff (duplication
  windows, churn ratio, TODO/debug/commented-out residue, test-tamper) plus an
  LLM judge scoring the qualitative residual, and a cross-bundle **pairwise**
  A/B judge for ranking. (#8, #27)
- **Blast radius** — a task or campaign link may declare `expectedSurface`
  globs; the harness mechanically computes out-of-scope **excursions** and the
  judge classifies each (necessary / defensible / overreach / adversarial). Any
  adversarial excursion disqualifies the cell from craft aggregation. Now armed
  on a real task. (#8, #7)

### Craft — matured into a trustworthy signal
- **Two new craft dimensions: `documentation` and `testing`** — scored on
  *value, not volume*. Proactive docs and meaningful tests now count **for** an
  agent instead of being ignored or (in the case of docs) penalized as
  overreach. Reconciled with `economy` so they're never double-penalized as
  verbosity. (#38, + testing dimension)
- **Severity-weighted pairwise verdicts** — a soundness-implicating win
  (catching a real defect: an open redirect, a missing guard) counts as 3
  stylistic wins, so a caught vulnerability is no longer outweighed by a naming
  or import nit. Fail-closed to ordinary weight. (#35)
- **Composite Craft Score** — `round(100·(0.7·winRate + 0.3·SlopHealth))` using
  a **head-to-head macro-average** win rate (beating the weakest variant no
  longer inflates a score) with a **confidence layer**: thin samples render
  `≈` / `⚠ low-confidence` instead of false precision, and a shutout or large
  gap still separates. (#27, #34)
- **Both-order pairwise de-biasing** — opt-in `--pairwise-both-orders` judges
  each pair in both A/B seatings and combines (a verdict that flips on swap
  resolves to tie), cancelling judge position bias deterministically instead of
  relying on randomization at small N. (#36)
- **Slop measures agent-authored production code only** — doc files, test files,
  and generated lockfiles (`package-lock.json`, `yarn.lock`, …) are excluded
  from the code-hygiene metrics (they're rewarded or handled elsewhere, not
  slop). Duplication now carries **per-file evidence** for auditability;
  `testTamper` still guards test-weakening. This closes a false-positive where
  npm's lockfile duplication crashed the SlopHealth of any variant that added a
  dependency. (#43, #45)
- **`testTamper` counts net assertion loss** — a legitimate assertion rewrite
  forced by a schema change no longer false-positives as tampering. (#6)

### Correctness — made real
- **`testCommand` / `judgeOnly`** — tasks with a runnable in-container harness
  now produce a real deterministic pass/fail verdict; tasks that genuinely
  can't run tests in-container are explicitly `judgeOnly` (by design, not
  silently empty) and marked distinctly in the Correctness table. (#22)
- **Honest signposting** — a loud warning when a matrix has scored cells but
  zero deterministic verdicts; the executor log now prints the real test
  verdict, not mere test-file presence. (#9)
- **Hardened judge parse** — recovers fenced / prose-wrapped / trailing-comma /
  truncated JSON (last-parseable object wins, so a leading example can't shadow
  the verdict) to cut spurious cell exclusions; fail-closed on true garbage. (#12)

### Memory
- **Held-by-abstraction (`✓A`) is now earnable** — the campaign induces a
  reusable helper so a bundle that *generalizes* a convention grades `✓A` (the
  gold-standard memory result) while a literal re-emitter grades `✓L`. A
  reproduced **false-✓A** (a drift link graded gold via a shared domain noun) is
  closed by decoupling the linkage-exclusion vocabulary from `appliesIf` and a
  token-boundary declaration-only harvest. A `✓A` headline callout now fires for
  campaign-earned wins. (#13, #28, #37)
- **`memory-registry` flagged non-discriminating (`✝`)** — a memoryless bundle
  recovers the rule from repo/task context, so a hold there is not a memory
  win. (#14)
- **Drift vs trap** — the campaign summary now splits cumulative adherence into
  held / drift / trap / unknown (different failure modes, different costs). (#15)

### Reporting & observability
- **Reliability** — with `--repeats N`, per-cell min/mean/max + σ dispersion
  across the three major axes and per-dimension craft ranges. (#19)
- **Sparklines** — campaign adherence trajectory and per-task efficiency. (#21)
- **Cross-task insight** — a synthesized narrative callout derived from the
  behavioral/efficiency data already in the report. (#18)
- **`--focus <axis>`** — render a focused report for one concern
  (`correctness` / `memory` / `craft` / `efficiency` / `blast-radius`); the JSON
  payload stays complete. (#20)
- **Token accounting** — the Efficiency input-token column is labeled
  `(uncached)`; it's the CLI's uncached delta, not total context cost. (#11)

### Fixes rolled up
`#6` `#7` `#9` `#10` `#11` `#12` `#13` `#14` `#15` `#16` `#17` `#18` `#19` `#20`
`#21` `#22` `#28` `#35` `#37` `#38` `#43` `#45` — see the v0.3 milestone.

## v0.2 — Longitudinal campaign mode

Longitudinal "campaign" execution mode: an ordered chain of tasks in one
persistent workspace per bundle, measuring memory's **compounding** value
(convention adherence across a context reset) that the single-shot design made
invisible. (PR #5)
