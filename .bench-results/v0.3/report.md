# CLAUDE.md Variant Benchmark Report

- **Run ID**: `094e2c0e-4466-42c0-8070-aee5140515a9`
- **Task**: Arbitrary conventions must stay consistent across a task chain, Runtime setup step must be remembered across a reset, Arbitrary registration rule must carry across a reset, Fix payment failures & double-charges under concurrent load, Implement resolveSafeRedirect + Express handler, Harden payment webhook ingestion (signature, replay, idempotency) (`campaign-conventions,memory-gotcha,memory-registry,prisma-tx-deadlock,safe-redirect,webhook-hardening`)
- **Executor model(s)**: sonnet
- **Judge model (fixed)**: opus
- **Generated**: 2026-07-15T17:47:22.893Z

## Cross-task insight

> `gstack` produced a leaner diff than `agentic-os` on `safe-redirect` (+224 vs +715 LOC) at ~2.5× lower cost and ~2.4× lower wall time. `agentic-os` used sub-agents on 3/5 tasks. On composite Craft Score, `agentic-os` led (76) over `naked` (32).

## Correctness

_Tested cells report the deterministic testCommand verdict; `judge-only` cells have no in-container harness and are graded by the judge BY DESIGN (distinct from a `—` cell that is simply missing a testCommand); untested cells report the judge's hedged read. Different evidence classes — never blended into one number._

| Variant | Model | Tests | Judge fallback (untested cells) |
| --- | --- | --- | --- |
| agentic-os | sonnet | 3/3 pass (12 judge-only) | likely_correct: 27 · likely_incorrect: 0 · unknown: 0 |
| gstack | sonnet | 3/3 pass (12 judge-only) | likely_correct: 25 · likely_incorrect: 0 · unknown: 2 |
| naked | sonnet | 3/3 pass (12 judge-only) | likely_correct: 25 · likely_incorrect: 0 · unknown: 2 |

## Memory effect (not scored)

_Deterministic readout: did each bundle hold the required convention across a context reset? Anchors are mechanical (not the judge)._

_Grades: ✓A = held-by-abstraction · ✓L = held-by-literal · ~I = held-by-inertia · ~C = held-by-chain · ✗ = drift · ⚠ = trap · ? = unknown._

#### Contrast — memory helped vs hurt (per bundle)

_✓ held = kept the required convention; ✗ hit trap = adopted the known wrong convention._

_✝ non-discriminating: a memoryless bundle also recovers this rule from repo/task context (issue #14) — a hold here is not a memory win._

| Variant | `memory-gotcha` | `memory-registry` ✝ |
| --- | --- | --- |
| agentic-os | ⚠ | ✓L (11 turns) |
| gstack | ⚠ | ✓L (14 turns) |
| naked | ⚠ | ✓L (13 turns) |

### Task: `memory-gotcha`

| Variant | Convention held | Turns to green | Hit known trap | Evidence |
| --- | --- | --- | --- | --- |
| agentic-os | ⚠ | — | ⚠️ yes | hit trap (/Cannot find module.*fixtures\.gen/) then ran setup — reactive, not proactive |
| agentic-os | ⚠ | — | ⚠️ yes | hit trap (/Cannot find module.*fixtures\.gen/) then ran setup — reactive, not proactive |
| agentic-os | ⚠ | — | ⚠️ yes | hit trap (/Cannot find module.*fixtures\.gen/) then ran setup — reactive, not proactive |
| gstack | ⚠ | — | ⚠️ yes | hit trap (/Cannot find module.*fixtures\.gen/) then ran setup — reactive, not proactive |
| gstack | ⚠ | — | ⚠️ yes | hit trap (/Cannot find module.*fixtures\.gen/) then ran setup — reactive, not proactive |
| gstack | ⚠ | — | ⚠️ yes | hit trap (/Cannot find module.*fixtures\.gen/) then ran setup — reactive, not proactive |
| naked | ⚠ | — | ⚠️ yes | hit trap (/Cannot find module.*fixtures\.gen/) then ran setup — reactive, not proactive |
| naked | ⚠ | — | ⚠️ yes | hit trap (/Cannot find module.*fixtures\.gen/) then ran setup — reactive, not proactive |
| naked | ⚠ | — | ⚠️ yes | hit trap (/Cannot find module.*fixtures\.gen/) then ran setup — reactive, not proactive |
### Task: `memory-registry`

| Variant | Convention held | Turns to green | Hit known trap | Evidence |
| --- | --- | --- | --- | --- |
| agentic-os | ✓L | 13 | no | held registry rule: final-step diff modifies src/registry.ts |
| agentic-os | ✓L | 15 | no | held registry rule: final-step diff modifies src/registry.ts |
| agentic-os | ✓L | 11 | no | held registry rule: final-step diff modifies src/registry.ts |
| gstack | ✓L | 14 | no | held registry rule: final-step diff modifies src/registry.ts |
| gstack | ✓L | 13 | no | held registry rule: final-step diff modifies src/registry.ts |
| gstack | ✓L | 14 | no | held registry rule: final-step diff modifies src/registry.ts |
| naked | ✓L | 8 | no | held registry rule: final-step diff modifies src/registry.ts |
| naked | ✓L | 14 | no | held registry rule: final-step diff modifies src/registry.ts |
| naked | ✓L | 13 | no | held registry rule: final-step diff modifies src/registry.ts |

## Memory effect (campaign, not scored)

> **✓A held-by-abstraction:** agentic-os on `t5-revisions` reused a prior abstraction rather than re-emitting the convention literal — the strongest memory signal. Mechanical, not scored.

**Cumulative adherence:** agentic-os 1/3 adhered (1 held · 0 drift · 2 trap) | agentic-os 1/3 (1 held · 0 drift · 2 trap) | agentic-os 3/3 (3 held · 0 drift · 0 trap) | gstack 0/3 (0 held · 0 drift · 3 trap) | gstack 0/3 (0 held · 0 drift · 3 trap) | gstack 0/3 (0 held · 1 drift · 2 trap) | naked 0/3 (0 held · 0 drift · 3 trap) | naked 0/3 (0 held · 0 drift · 3 trap) | naked 0/3 (0 held · 0 drift · 3 trap)

_Anchored links whose required convention held, per bundle — a memory bundle should stay consistent across the chain while a memoryless one drifts. Anchors are mechanical (not the judge)._

_Grades: ✓A = held-by-abstraction · ✓L = held-by-literal · ~I = held-by-inertia · ~C = held-by-chain · ✗ = drift · ⚠ = trap · ? = unknown._

#### Per-task trajectory

_Adherence sparkline per bundle across the chain (higher = stronger hold: trap/drift low → held-by-literal mid → held-by-abstraction high). Observational only._

- agentic-os `▁▆▁`
- agentic-os `▁▆▁`
- agentic-os `▆▆█`
- gstack `▁▁▁`
- gstack `▁▁▁`
- gstack `▂▁▁`
- naked `▁▁▁`
- naked `▁▁▁`
- naked `▁▁▁`

_Cell = adherence · executor turns. ✓ held = kept the convention; ✗ drift = broke it; ⚠ trap = adopted the known-wrong convention; — = no anchor (judged only); ✗fail = link failed; ☠ = disqualified (adversarial)._

| Task | agentic-os | agentic-os | agentic-os | gstack | gstack | gstack | naked | naked | naked |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| #0 `t1-search` | — · 10t | — · 20t | — · 18t | — · 21t | — · 17t | — · 19t | — · 18t | — · 27t | — · 27t |
| #1 `t2-rename` | — · 13t | — · 16t | — · 13t | — · 11t | — · 12t | — · 12t | — · 14t | — · 14t | — · 14t |
| #2 `t3-created-at` | ⚠ · 15t | ⚠ · 16t | ✓L · 17t | ⚠ · 15t | ⚠ · 13t | ✗ · 12t | ⚠ · 12t | ⚠ · 16t | ⚠ · 17t |
| #3 `t4-attachments` | ✓L · 22t | ✓L · 12t | ✓L · 13t | ⚠ · 14t | ⚠ · 22t | ⚠ · 16t | ⚠ · 12t | ⚠ · 12t | ⚠ · 13t |
| #4 `t5-revisions` | ⚠ · 18t | ⚠ · 12t | ✓A · 14t | ⚠ · 13t | ⚠ · 15t | ⚠ · 13t | ⚠ · 17t | ⚠ · 13t | ⚠ · 12t |

## Craft

### Slop (deterministic)

_Mechanical diff signals — re-derivable by hand. Churn applies to campaign links only. Helper reuse (higher = shared helpers reused) and Literal density (higher = magic literals inlined) are summed over cells. Literal density is OBSERVATIONAL only — it never feeds SlopHealth/Craft Score, and legitimately literal-heavy code (HTTP status codes, string messages) can raise it. Disqualified cells excluded._

| Variant | Model | Duplication Δ (mean) | Churn (mean) | TODOs | Debug logs | Commented-out | Test tamper | Helper reuse | Literal density |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| agentic-os | sonnet | 0.2 | 0.02 | 0 | 5 | 1 | 8 | 16 | 630 |
| gstack | sonnet | 0.1 | 0.03 | 0 | 7 | 8 | 11 | 24 | 512 |
| naked | sonnet | 0.2 | 0.02 | 0 | 7 | 4 | 8 | 10 | 614 |

### Judge craft (medians)

_Lower median (ordinal 0–4) over scored, non-disqualified cells. `unknown` scores never enter a median — they are counted instead (fail-closed)._

| Variant | Model | Naming | Structure | Consistency | Economy | Documentation | Testing | Unknown scores | Cells |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| agentic-os | sonnet | 3 | 3 | 3 | 3 | 3 | 3 | 0 | 30 |
| gstack | sonnet | 3 | 3 | 3 | 3 | 3 | 3 | 0 | 30 |
| naked | sonnet | 3 | 3 | 3 | 3 | 3 | 3 | 0 | 30 |

### Pairwise (cross-bundle)

_Same-cell A/B craft comparisons (overall winner per comparison). Win rates are SEVERITY-WEIGHTED: a soundness-implicating win (correctness/security/robustness) counts as 3 stylistic wins, so a caught defect is not outweighed by a naming/import nit (fail-closed: a missing/invalid severity is ordinary weight). Global win rate = weighted wins/(weighted wins+losses) pooled across all opponents; H2H win rate = macro-average of per-opponent weighted head-to-head rates (each opponent weighted once — the rate the Craft Score consumes). Decisive = raw wins+losses; ties excluded from both rates._

- agentic-os vs gstack: 5–2 (6 ties)
- naked vs agentic-os: 1–5 (7 ties)
- naked vs gstack: 0–6 (9 ties)

| Variant | Global win rate | H2H win rate | Decisive | W–L–T |
| --- | --- | --- | --- | --- |
| agentic-os | 74% | 74% | 13 | 10–3–13 |
| gstack | 61% | 65% | 13 | 8–5–15 |
| naked | 13% | 11% | 12 | 1–11–16 |

_Position-bias audit: A-slot won 10 of 19 decisive comparisons (expected ≈50%)._

### Craft Score (ranking summary)

_Within-Craft ranking summary — NOT a cross-axis total (axes are never summed; this combines only Craft's own sub-signals). `Score = round(100·(0.7·winRate + 0.3·SlopHealth))`, where winRate is the HEAD-TO-HEAD macro-average (each opponent weighted once, so beating one weak variant repeatedly earns no extra credit), dup capped at 10. A variant with fewer than 3 decisive comparisons drops the winRate term and is flagged `(slop-only)` (never imputed). Confidence layer: a scored row backed by fewer than 5 decisive comparisons is flagged `⚠ low-confidence (n=…)`; two adjacent rows share a rank band and render `≈` (not separable) when their direct head-to-head is thin (< 5 decisive) AND their Craft Score gap is under 25 AND the lower row won at least one of those comparisons — a head-to-head shutout (0 wins) or a ≥ 25-point gap still separates them. testTamper is a soft penalty via SlopHealth. Disqualified cells are excluded from the inputs but keep their ☠ mark._

| Rank | Variant | Model | Craft Score | Win rate | Slop health |
| --- | --- | --- | --- | --- | --- |
| 1 | agentic-os | sonnet | 76 | 74% | 0.82 |
| 2 | gstack | sonnet | 68 | 65% | 0.76 |
| 3 | naked | sonnet | 32 | 11% | 0.81 |

## Efficiency

_Observed cost/time, summed across each (variant × model)'s task(s). Cost/task = per-task exec-cost sparkline, min/max-normalized WITHIN each unit (relative shape, not absolute magnitude). Observed only — never a score component._

| Variant | Model | Exec time (s) | Exec cost (USD) | Input tok (uncached) | Output tok | Turns | Judge cost (USD) | Cost/task |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| agentic-os | sonnet | 5429.6s | $34.8575 | 5.7k | 574.4k | 244 | $2.0205 | ▁▁▁▁▁▁▁▂▃█▂▃▇▆▇ |
| gstack | sonnet | 2272.7s | $13.9206 | 13.5k | 178.7k | 362 | $1.3550 | ▂▁▂▁▁▁▄▃▃▃▄▄▄█▅ |
| naked | sonnet | 1810.9s | $7.9378 | 13.1k | 139.0k | 347 | $1.7601 | ▁▂▂▁▁▁▄▃▃▆▅▄▅█▇ |

## Reliability

_Dispersion across --repeats runs of the same (task × variant × model) cell — the three major axes plus per-dimension craft ranges. Correctness = correct runs / runs with a verdict; Craft score = per-run mean-of-dimensions as min/mean/max; σ = population standard deviation of cost/time. Executor-failed repeats are excluded (coverage gaps, not variance). Observed, never a score component._

| Cell | Runs | Correctness | Craft score (min/mean/max) | Exec cost σ | Wall time σ | Naming | Structure | Consistency | Economy | Documentation | Testing | Craft unknowns | Anchor grades |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `memory-gotcha` × agentic-os [sonnet] | 3 | 3/3 correct | 2.7 / 2.9 / 3.3 | $0.0547 | 5.8s | 3 | 3–4 | 3–4 | 3–4 | 2 | 2–3 | 0 | 3/3 identical |
| `memory-registry` × agentic-os [sonnet] | 3 | 3/3 correct | 2.7 / 2.8 / 3.0 | $0.0177 | 7.2s | 3 | 3 | 2–3 | 3 | 2–3 | 3 | 0 | 3/3 identical |
| `prisma-tx-deadlock` × agentic-os [sonnet] | 3 | 3/3 correct | 2.7 / 2.7 / 2.8 | $0.6290 | 95.3s | 3 | 3 | 3 | 3 | 3–4 | 1 | 0 | — |
| `safe-redirect` × agentic-os [sonnet] | 3 | 3/3 correct | 3.3 / 3.5 / 3.7 | $2.8149 | 315.6s | 3–4 | 3–4 | 3 | 3 | 4 | 4 | 0 | — |
| `webhook-hardening` × agentic-os [sonnet] | 3 | 3/3 correct | 2.8 / 3.2 / 3.7 | $0.6308 | 122.0s | 3–4 | 3–4 | 3 | 2–3 | 2–4 | 4 | 0 | — |
| `memory-gotcha` × gstack [sonnet] | 3 | 3/3 correct | 2.7 / 2.8 / 2.8 | $0.0250 | 2.8s | 3 | 3 | 3 | 3 | 2 | 2–3 | 0 | 3/3 identical |
| `memory-registry` × gstack [sonnet] | 3 | 3/3 correct | 2.8 / 2.9 / 3.0 | $0.0107 | 2.4s | 3 | 3 | 2–3 | 3 | 2–3 | 3 | 0 | 3/3 identical |
| `prisma-tx-deadlock` × gstack [sonnet] | 3 | 3/3 correct | 2.7 / 2.7 / 2.7 | $0.1130 | 28.0s | 3 | 3 | 3 | 3 | 3 | 1 | 0 | — |
| `safe-redirect` × gstack [sonnet] | 3 | 2/2 correct | 2.7 / 3.2 / 3.7 | $0.0293 | 19.6s | 3–4 | 3–4 | 3 | 3 | 3–4 | 1–4 | 0 | — |
| `webhook-hardening` × gstack [sonnet] | 3 | 3/3 correct | 3.0 / 3.2 / 3.5 | $0.4961 | 71.9s | 4 | 4 | 3 | 3 | 3–4 | 1–3 | 0 | — |
| `memory-gotcha` × naked [sonnet] | 3 | 3/3 correct | 2.8 / 3.1 / 3.2 | $0.0225 | 5.9s | 3 | 3–4 | 3 | 3–4 | 2 | 3 | 0 | 3/3 identical |
| `memory-registry` × naked [sonnet] | 3 | 3/3 correct | 2.8 / 3.0 / 3.2 | $0.0065 | 2.9s | 3 | 3–4 | 2–3 | 3–4 | 2–3 | 3 | 0 | 3/3 identical |
| `prisma-tx-deadlock` × naked [sonnet] | 3 | 2/2 correct | 2.7 / 2.7 / 2.7 | $0.0105 | 6.5s | 3 | 3 | 3 | 3 | 3 | 1 | 0 | — |
| `safe-redirect` × naked [sonnet] | 3 | 2/2 correct | 3.0 / 3.1 / 3.2 | $0.1350 | 17.4s | 3 | 3 | 3 | 2–3 | 3 | 4 | 0 | — |
| `webhook-hardening` × naked [sonnet] | 3 | 3/3 correct | 2.7 / 2.9 / 3.0 | $0.1813 | 43.4s | 3–4 | 3–4 | 3 | 3 | 3 | 1–3 | 0 | — |

_Targeting: spend repeats on the high-variance, high-turn cells — `prisma-tx-deadlock`, `safe-redirect`, and the campaign chain — rather than uniformly across the matrix; uniform repeats mostly re-confirm the cells that were already stable. Guidance only, not enforced._

## Blast radius

_Out-of-scope files (mechanically computed from expectedSurface) with the judge's read on each excursion. Any adversarial entry disqualifies the cell from craft aggregation._

| Cell | File | Classification | Evidence |
| --- | --- | --- | --- |
| `webhook-hardening__agentic-os__sonnet__r1` | `test/webhooks.test.mjs` | defensible | Exercises src/app.mjs end-to-end over real HTTP |
| `webhook-hardening__agentic-os__sonnet__r2` | `test/webhooks.test.mjs` | defensible | Integration tests for POST /webhooks/payments against a live app.listen(0) |
| `webhook-hardening__agentic-os__sonnet__r3` | `test/webhooks.test.mjs` | defensible | new test suite exercising signature/skew/idempotency/fail-closed |
| `webhook-hardening__gstack__sonnet__r1` | `package-lock.json` | defensible | "dev": true, added to fsevents entry |
| `webhook-hardening__gstack__sonnet__r2` | `package-lock.json` | defensible | fsevents "dev": true |
| `webhook-hardening__gstack__sonnet__r2` | `test/webhooks.test.mjs` | defensible | new test suite exercising verification and idempotency |
| `webhook-hardening__naked__sonnet__r2` | `package-lock.json` | defensible | "dev": true added to fsevents entry |
| `webhook-hardening__naked__sonnet__r3` | `test/webhooks.test.mjs` | defensible | Integration coverage for the hardened webhook endpoint |

## Excluded cells (not scored)

_None — every attempted cell produced a judged result._

## Behavioral signals (not scored)

_What each run actually did — sub-agent usage, tool calls, and diff shape. Observational only; these prove different CLAUDE.md variants produce genuinely different behavior, not just different scores._

### Task: `memory-gotcha`

| Variant | Sub-agents | Tool calls | Files (src/test/docs) | LOC ± | Tests added | Diff hash |
| --- | --- | --- | --- | --- | --- | --- |
| agentic-os | 0 | 16 | 1/1/0 | +10/-1 | 1 | `ad8adbeb` |
| agentic-os | 0 | 11 | 1/1/0 | +10/-1 | 1 | `431b8d96` |
| agentic-os | 0 | 11 | 1/1/0 | +10/-1 | 1 | `431b8d96` |
| gstack | 0 | 15 | 1/1/0 | +10/-1 | 1 | `431b8d96` |
| gstack | 0 | 11 | 1/1/0 | +10/-1 | 1 | `431b8d96` |
| gstack | 0 | 13 | 1/1/0 | +10/-1 | 1 | `431b8d96` |
| naked | 0 | 11 | 1/1/0 | +10/-1 | 1 | `431b8d96` |
| naked | 0 | 13 | 1/1/0 | +10/-1 | 1 | `431b8d96` |
| naked | 0 | 16 | 1/1/0 | +10/-1 | 1 | `431b8d96` |

### Task: `memory-registry`

| Variant | Sub-agents | Tool calls | Files (src/test/docs) | LOC ± | Tests added | Diff hash |
| --- | --- | --- | --- | --- | --- | --- |
| agentic-os | 0 | 12 | 2/1/0 | +18/-0 | 2 | `4e7f61a6` |
| agentic-os | 0 | 14 | 2/1/0 | +19/-0 | 2 | `f519743d` |
| agentic-os | 0 | 10 | 2/1/0 | +23/-0 | 3 | `32783117` |
| gstack | 0 | 13 | 2/1/0 | +22/-0 | 3 | `9c28c6bd` |
| gstack | 0 | 12 | 2/1/0 | +18/-0 | 2 | `b64e2172` |
| gstack | 0 | 13 | 2/1/0 | +18/-0 | 2 | `4ba46899` |
| naked | 0 | 7 | 2/1/0 | +18/-0 | 2 | `b64e2172` |
| naked | 0 | 13 | 2/1/0 | +18/-0 | 2 | `b2a21c0b` |
| naked | 0 | 12 | 2/1/0 | +18/-0 | 2 | `0766540f` |

### Task: `prisma-tx-deadlock`

| Variant | Sub-agents | Tool calls | Files (src/test/docs) | LOC ± | Tests added | Diff hash |
| --- | --- | --- | --- | --- | --- | --- |
| agentic-os | 0 | 20 | 2/0/0 | +45/-14 | 0 | `34df0f15` |
| agentic-os | 0 | 27 | 2/0/0 | +59/-15 | 0 | `fd6161a2` |
| agentic-os | 2 (security-reviewer, code-reviewer) | 64 | 3/0/0 | +73/-27 | 0 | `a6e0d5f6` |
| gstack | 0 | 28 | 2/0/0 | +58/-16 | 0 | `499e47a8` |
| gstack | 0 | 24 | 1/0/0 | +41/-15 | 0 | `4ba9187c` |
| gstack | 0 | 21 | 3/0/0 | +61/-15 | 0 | `708c112e` |
| naked | 0 | 22 | 1/0/0 | +41/-19 | 0 | `e3ba141f` |
| naked | 0 | 19 | 3/0/0 | +41/-20 | 0 | `984f70ac` |
| naked | 0 | 14 | 2/0/0 | +50/-15 | 0 | `dec06c30` |

### Task: `safe-redirect`

| Variant | Sub-agents | Tool calls | Files (src/test/docs) | LOC ± | Tests added | Diff hash |
| --- | --- | --- | --- | --- | --- | --- |
| agentic-os | 5 (engineer, data-model-documenter, security-reviewer, code-reviewer) | 196 | 5/1/0 | +1222/-4 | 26 | `7ece5c11` |
| agentic-os | 0 | 22 | 2/1/0 | +231/-0 | 25 | `4a605889` |
| agentic-os | 1 (security-reviewer) | 58 | 5/2/0 | +692/-2 | 23 | `66ad1730` |
| gstack | 0 | 20 | 2/0/0 | +140/-0 | 0 | `c43eb907` |
| gstack | 0 | 21 | 2/2/0 | +266/-0 | 21 | `70e4a759` |
| gstack | 0 | 24 | 7/1/0 | +266/-2 | 17 | `23eca844` |
| naked | 0 | 33 | 6/1/0 | +546/-4 | 20 | `65050657` |
| naked | 0 | 27 | 7/2/0 | +1209/-4 | 23 | `972ba485` |
| naked | 0 | 15 | 3/1/0 | +204/-0 | 20 | `acf88782` |

### Task: `webhook-hardening`

| Variant | Sub-agents | Tool calls | Files (src/test/docs) | LOC ± | Tests added | Diff hash |
| --- | --- | --- | --- | --- | --- | --- |
| agentic-os | 6 (engineer, data-model-documenter, security-reviewer, code-reviewer) | 232 | 7/1/2 | +518/-28 | 6 | `f3205fc1` |
| agentic-os | 3 (engineer, security-reviewer, code-reviewer) | 188 | 7/1/1 | +340/-31 | 10 | `3952715b` |
| agentic-os | 6 (engineer, data-model-documenter, security-reviewer, code-reviewer) | 221 | 6/1/2 | +549/-31 | 8 | `c18087dc` |
| gstack | 0 | 37 | 8/0/1 | +154/-35 | 0 | `6e52e12b` |
| gstack | 0 | 51 | 7/1/1 | +378/-33 | 11 | `0264d118` |
| gstack | 0 | 44 | 6/0/1 | +127/-41 | 0 | `6022a5d4` |
| naked | 0 | 35 | 7/0/1 | +145/-32 | 0 | `6ac05fff` |
| naked | 0 | 51 | 8/0/1 | +164/-48 | 0 | `0d46d962` |
| naked | 0 | 44 | 7/1/1 | +206/-32 | 4 | `866eacbf` |
