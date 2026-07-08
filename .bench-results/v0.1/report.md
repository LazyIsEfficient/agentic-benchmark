# CLAUDE.md Variant Benchmark Report

- **Run ID**: `b0aedcaa-45a9-4b72-8c8b-85de037c7f7e`
- **Task**: Fix payment failures & double-charges under concurrent load, Implement resolveSafeRedirect + Express handler, Harden payment webhook ingestion (signature, replay, idempotency) (`prisma-tx-deadlock,safe-redirect,webhook-hardening`)
- **Executor model(s)**: sonnet
- **Judge model (fixed)**: opus
- **Generated**: 2026-07-08T21:21:28.188Z
- **Top result**: `agentic-os` (85.7/100 mean, 3/3 scored)

## Score matrix

| Variant | Code Quality /30 | Testing /40 | Security /20 | Docs /10 | **Total /100** | Scored |
| --- | --- | --- | --- | --- | --- | --- |
| agentic-os | 26.7 | 32.7 | 18.7 | 7.7 | **85.7** | 3/3 scored |
| naked | 26.3 | 27.7 | 14.7 | 6.7 | **75.3** | 3/3 scored |
| gstack | 26.7 | 26 | 15 | 7.3 | **75** | 3/3 scored |

## Excluded cells (not scored)

_None — every attempted cell produced a judged result._

## Consistent strengths / weaknesses

- **Code Quality**: strongest `agentic-os` (26.7/30), weakest `naked` (26.3/30).
- **Testing Coverage**: strongest `agentic-os` (32.7/40), weakest `gstack` (26/40).
- **Security Quality**: strongest `agentic-os` (18.7/20), weakest `naked` (14.7/20).
- **Documentation**: strongest `agentic-os` (7.7/10), weakest `naked` (6.7/10).

## Run metrics (not scored)

_Observed cost/time, summed across each (variant × model)'s task(s). NOT part of the /100 score._

| Variant | Model | Exec time (s) | Exec cost (USD) | Input tok | Output tok | Turns | Judge cost (USD) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| agentic-os | sonnet | 1589.6s | $7.5899 | 0.1k | 26.8k | 56 | $0.4943 |
| naked | sonnet | 657.1s | $3.0795 | 0.2k | 54.6k | 119 | $0.4641 |
| gstack | sonnet | 698.4s | $3.6379 | 0.1k | 54.2k | 93 | $0.3766 |

## Per-variant detail

### agentic-os — task `prisma-tx-deadlock` — model `sonnet`

## Scores

- **Code Quality**: 26/30 — Clean, idiomatic refactor: extracted claimOrder as an atomic compare-and-swap, kept the final status+ledger write in one short $transaction, mapped domain error codes to HTTP statuses, and thoroughly documented intent in updated docstrings. Minor smells only — the diagnostic findUnique after a failed CAS is a small TOCTOU (self-acknowledged, message-only) and the swallowed revert path is best-effort.
- **Testing Coverage**: 29/40 — Uses the repo-appropriate node:test framework and adds a genuine regression test asserting exactly one winner, one ledger entry, and ORDER_NOT_PENDING for losers under 8-way concurrency. Docked for narrowness: only concurrency=8 (not the 40 the task emphasizes), no happy-path unit test, and no test for the chargeCard-failure revert branch.
- **Security Quality**: 18/20 — A visible, deliberate security review was run (sub-agent) surfacing real, evidence-backed findings: missing processor idempotency key (double-charge on ambiguous retry), stuck-in-processing on final-commit failure, and raw error leakage on 500. No injection risk (Prisma-parameterized); the core money-safety race is genuinely closed and documented as known-limitations where out of scope.
- **Documentation**: 7/10 — Excellent inline docstrings explaining root cause, the three-step design, and why updateMany is used, plus a thorough root-cause/known-limitations write-up. Docked because no README or architecture doc was updated despite the task documenting an atomicity invariant worth capturing outside comments.

**Total Score: 80/100**

## Summary
A strong, senior-grade concurrency fix: correctly diagnoses the held-transaction pool timeout plus the unconditional-update double-charge, and resolves both with an atomic CAS claim and a short final transaction preserving the documented atomicity invariant. The agent ran explicit parallel security and code reviews, acted on the concrete findings (updateMany to kill log spam, logging the revert), added a real regression test, and honestly documented remaining tradeoffs rather than overbuilding. Main gaps are test breadth (single scenario at low concurrency, no error-path coverage) and absence of external doc updates.

---

### agentic-os — task `safe-redirect` — model `sonnet`

## Scores

- **Code Quality**: 27/30 — Clean separation between resolver and handler, excellent naming, well-documented rationale, no magic numbers, and idiomatic use of the WHATWG URL parser. Comments explain non-obvious security reasoning; the only minor knock is some verbosity in inline commentary.
- **Testing Coverage**: 36/40 — Uses node:test with 15 well-organized tests covering happy path plus extensive edge cases (javascript:/data:, protocol-relative, backslash variants, embedded credentials, credential/host confusion, tab-smuggling, empty/whitespace, non-string input). The Express handler itself has no dedicated test, which is the main gap.
- **Security Quality**: 19/20 — A genuine adversarial security review was performed with raw-source execution of crafted bypass payloads, and a Tier-2 finding (incidental vs. enforced host-discard) was fixed with defense-in-depth plus a regression test. Exact-match allowlist, credential rejection, and scheme validation are all correct.
- **Documentation**: 7/10 — Thorough JSDoc on both exported functions including usage example and threat rationale, but no README or standalone docs were added to the empty project.

**Total Score: 89/100**

## Summary
A strong, security-conscious implementation of a notoriously bug-prone primitive, backed by an unusually rigorous adversarial security review that executed crafted payloads rather than merely reading code. Test coverage is broad and framework-appropriate, with the main gaps being the untested Express handler and absence of project-level documentation. This is senior-quality work that fails closed by design and hardens a real (if non-exploitable) design smell surfaced during review.

---

### agentic-os — task `webhook-hardening` — model `sonnet`

## Scores

- **Code Quality**: 27/30 — Clean separation: HMAC verification isolated in src/lib/webhookAuth.mjs with fail-closed try/catch, raw-body capture via express.json verify callback, idempotency via DB constraint + P2002 catch. Small focused functions, good naming, consistent ESM style; magic numbers (300, prefix) are named constants.
- **Testing Coverage**: 33/40 — Uses node:test with real HTTP via app.listen(0)+fetch and shared signing helper; covers happy path, missing/bad signature, stale timestamp, and idempotent retry with row-count assertions. Docks for no concurrency test (the TOCTOU/P2002 path is untested) and no verified-but-malformed-body 400 test.
- **Security Quality**: 19/20 — Explicit dedicated security-review agent checked constant-time comparison, fail-closed branches, raw-body integrity, TOCTOU, and info leaks; timingSafeEqual with length guard, secret-missing rejection, and DB-level idempotency all present. Minor residual: verbose 500 body ({error,code,name}) and unauthenticated /events noted but deferred as advisory.
- **Documentation**: 9/10 — README's contradictory 'insecure'/'intended' sections were merged into one accurate 'Current behavior' with signing table, status-code semantics, and working signed curl examples; DATA_MODEL.md and JSDoc/schema comments were updated to match the new contract.

**Total Score: 88/100**

## Summary
A high-quality, idiomatic hardening of the webhook endpoint that correctly implements HMAC verification, replay protection, and DB-enforced idempotency, backed by real HTTP tests. A dedicated security review and code review were run; the latter reproduced and fixed a genuine migration bug (unique index would fail on pre-existing duplicate rows) with a dedup step. Testing is solid but misses concurrency and 400-body edge cases; residual advisory items (open /events, verbose 500s) were consciously deferred rather than addressed.

---

### naked — task `prisma-tx-deadlock` — model `sonnet`

## Scores

- **Code Quality**: 25/30 — The three-phase split (atomic conditional claim via updateMany, external call outside any transaction, fast batch finalize) is idiomatic Prisma, cleanly structured, and the updated docstring/comments clearly explain intent; only minor concern is an order can be left stuck in 'processing' if the process dies between claim and finalize.
- **Testing Coverage**: 9/40 — No test files were created or updated in the final state — the same-order concurrency check was written as a scratch file and explicitly deleted, so despite running the existing suite and manual load checks, the rubric's cap of 10 applies since behavior was modified with no persisted tests.
- **Security Quality**: 8/20 — No new vulnerabilities were introduced and the fix correctly enforces at-most-once charging (money-safety), but there is no visible security review or threat-modeling step on this payments-critical change, so the 8-point cap applies.
- **Documentation**: 6/10 — The function-level docstring was meaningfully rewritten to explain the new concurrency model and atomicity guarantees, and inline comments are thorough, but no README or external docs were updated.

**Total Score: 48/100**

## Summary
A technically strong, well-reasoned concurrency fix that correctly diagnoses the SQLite write-lock-held-across-network-call root cause and resolves both the contention failures and the double-charge via an atomic claim plus a lock-free external call. The main weakness is testing: verification relied on scratch scripts that were deleted, leaving zero persisted regression tests for the exact race the task centers on. Security was implicitly respected (at-most-once charging) but never explicitly reviewed, and documentation was limited to inline comments.

---

### naked — task `safe-redirect` — model `sonnet`

## Scores

- **Code Quality**: 27/30 — Small, single-responsibility functions with excellent naming, no magic values (constants extracted), and thoughtful comments explaining the `.invalid` base-origin trick; structural Express types avoid an unnecessary dependency. Only minor nit: the allowlist Set is rebuilt on each call rather than accepting a pre-normalized set.
- **Testing Coverage**: 38/40 — Uses node:test framework with 25 well-organized tests achieving 100% coverage on both source modules, covering happy paths and virtually all attack vectors (protocol-relative, backslash-authority, javascript:/data:/ftp:/file: schemes, embedded credentials, subdomain-suffix bypass, trailing-dot, non-string input, repeated query params).
- **Security Quality**: 18/20 — Visible, deliberate security work: agent researched WHATWG URL parser behavior, explicitly rejects credentials, non-http(s) schemes, protocol-relative/backslash tricks, and does exact (not suffix) host matching with case/trailing-dot normalization; no open-redirect gaps evident. Falls just short of full marks as no formal threat-model note was written beyond inline rationale.
- **Documentation**: 6/10 — Thorough, security-focused JSDoc on every exported symbol and a usage example in the handler comment, but no README or standalone usage/API doc was added to the previously empty project.

**Total Score: 89/100**

## Summary
A high-quality, security-conscious implementation that correctly leverages the WHATWG URL parser to defend against the full range of open-redirect vectors, with clean idiomatic TypeScript and 100%-covered tests using the proper node:test framework. Security was clearly and deliberately considered, evidenced by both the transcript research and inline rationale. The only meaningful gap is the absence of any README/API documentation for the new package.

---

### naked — task `webhook-hardening` — model `sonnet`

## Scores

- **Code Quality**: 27/30 — Clean separation into a dedicated verifyWebhookSignature module, extracted constants (ALLOWED_SKEW_SECONDS, SIGNATURE_PREFIX, UNIQUE_CONSTRAINT_VIOLATION), thorough JSDoc, and idiomatic raw-body capture via express.json verify hook; idempotency via catch-on-P2002 is a sensible, race-safe pattern with no notable duplication or god objects.
- **Testing Coverage**: 36/40 — Uses node:test with a real HTTP server harness and covers missing headers, tampered body, wrong secret, stale timestamp, valid delivery, and duplicate idempotency (asserting single DB row) — strong edge coverage that would catch real regressions; slightly short of malformed-signature/hex cases and relies on an unshown helper.
- **Security Quality**: 18/20 — Uses timingSafeEqual, verifies HMAC over exact raw bytes, enforces ±300s skew replay protection, fails closed on missing secret/headers/malformed input, and returns 401 without side effects; visible deliberate security reasoning throughout with no introduced vulnerabilities.
- **Documentation**: 8/10 — README updated from 'insecure/intended' to a normative secured contract with a working curl signing example and the new applied response field, plus solid inline JSDoc and schema comments explaining the unique constraint.

**Total Score: 89/100**

## Summary
A strong, senior-level hardening of the webhook endpoint that correctly implements HMAC signature verification, replay protection, fail-closed behavior, and DB-enforced idempotency with a timing-safe comparison. Testing is thorough and uses the appropriate node:test framework with meaningful assertions including single-row verification, and the agent both ran the suite and manually validated against a live server. Documentation and code structure are clean; only minor gaps (a couple of malformed-input test cases, unshown signing helper) keep it from a perfect score.

---

### gstack — task `prisma-tx-deadlock` — model `sonnet`

## Scores

- **Code Quality**: 25/30 — The fix is idiomatic and clean: a proper compare-and-swap via updateMany with count check, the slow processor call moved outside the transaction, and typed OrderNotFoundError/OrderNotChargeableError with HTTP statuses wired through the route. One residual concern is a crash between chargeCard and the final transaction leaving the card charged with the order stuck in 'processing' and no ledger row, but the code stays readable and well-structured.
- **Testing Coverage**: 9/40 — No test files were created or updated despite behavior-changing concurrency logic — verification was done only through throwaway bash scripts, so the rubric caps this dimension at 10. Credit given for running the existing suite (npm test passes) and thorough manual reproduction/verification at CONCURRENCY=40/100.
- **Security Quality**: 8/20 — The core money-safety bug (double-charge/at-most-once) is correctly addressed, but there is no visible formal security review, and the route still surfaces raw Prisma error message/code/name to clients (information disclosure) which was left unaddressed. Capped at 8 due to no distinct security review step.
- **Documentation**: 7/10 — The docstring in orderService.mjs was substantially rewritten to explain the claim/CAS lock, the out-of-transaction processor call, and the preserved atomicity guarantee, and the final message clearly explains root cause and fix. No README/API docs were updated.

**Total Score: 49/100**

## Summary
A well-diagnosed and idiomatic fix that correctly identifies both root causes (unconditional status flip and a 2s external call held inside the SQLite single-writer transaction) and resolves them with a real atomic claim plus a short final transaction. The main weakness is the complete absence of committed test files despite behavior-changing concurrency logic, which caps testing under the rubric. Security-relevant money-safety is handled, but no formal security review was performed and a minor error-leak in the route path remains.

---

### gstack — task `safe-redirect` — model `sonnet`

## Scores

- **Code Quality**: 28/30 — Clean separation across safe-redirect/handler/index, excellent JSDoc, well-named consts (FALLBACK, sentinelOrigin), no duplication or magic values. Handles subtle edge cases (array query params, custom param name) idiomatically with readonly types.
- **Testing Coverage**: 38/40 — node:test framework used with 25 tests spanning happy paths, all required rejection classes (javascript/data/protocol-relative/credentials/userinfo-spoof/tab-newline smuggling/subdomain suffix) plus handler tests for missing/repeated/custom params; agent verified all pass. Slightly short of perfect but comprehensive.
- **Security Quality**: 19/20 — This is a security-focused task and the code shows deep threat awareness: exact hostname allowlist matching, credential rejection, control-char smuggling defense, backslash/protocol-relative handling verified against a sentinel origin. Comments explicitly reason about attack vectors, evidencing a real security review.
- **Documentation**: 7/10 — Thorough inline JSDoc on all exports including a usage example for the Express handler and rationale comments for each defense, but no README or standalone docs were added.

**Total Score: 92/100**

## Summary
A strong, security-conscious implementation of a safe redirect resolver with clean architecture and idiomatic TypeScript. The test suite is broad and directly targets each open-redirect attack class, and the code comments demonstrate genuine threat modeling. Only minor gaps: no README-level documentation and reliance on inline docs rather than external docs.

---

### gstack — task `webhook-hardening` — model `sonnet`

## Scores

- **Code Quality**: 27/30 — Clean separation: verifyWebhook.mjs is a pure, well-documented function, service handles idempotency via DB P2002 catch, route stays thin. Named constants (ALLOWED_SKEW_SECONDS, UNIQUE_CONSTRAINT_VIOLATION), raw-body capture, and a JSON parse error handler show thoughtful senior-level design with minimal duplication.
- **Testing Coverage**: 31/40 — Uses node:test framework with strong end-to-end coverage: valid signature, missing/tampered/wrong-secret rejection, stale and future timestamp skew, and retry idempotency asserting same id and exactly one row. Deducted because the suite imports ./helpers/sign.mjs which is absent from the diff/changed-files, leaving the tests' runnability unverifiable from the evidence, and there is no direct unit test of verifyWebhook.
- **Security Quality**: 18/20 — Timing-safe HMAC comparison with length check, fail-closed on any missing secret/header/malformed input, replay protection via ±300s skew, and signature verified over raw bytes rather than re-serialized JSON — all correct secure defaults with no introduced vulnerabilities.
- **Documentation**: 8/10 — README public contract was rewritten from the insecure placeholder to the shipped signed+idempotent behavior with a working curl signing example, and code carries clear JSDoc and rationale comments (raw-body verify, fail-closed).

**Total Score: 84/100**

## Summary
A high-quality hardening change that correctly implements HMAC verification with constant-time comparison, replay protection, fail-closed behavior, and DB-level idempotency handled cleanly via Prisma's P2002 code. Security was deliberately considered throughout, tests are well-structured across happy and error paths, and docs were meaningfully updated. The main weakness is a test helper (helpers/sign.mjs) referenced but not present in the evidence, which undermines confidence that the suite actually executes as claimed.
