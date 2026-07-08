# CLAUDE.md Variant Benchmark Report

- **Run ID**: `abd08421-b150-4abd-ae54-e98979eac459`
- **Task**: Add a priority field to tickets across Prisma, API, and frontend, Fix payment failures & double-charges under concurrent load, Implement resolveSafeRedirect + Express handler (`db-column-feature,prisma-tx-deadlock,safe-redirect`)
- **Executor model(s)**: sonnet
- **Judge model (fixed)**: opus
- **Generated**: 2026-07-08T15:45:10.013Z
- **Top result**: `naked` (60.3/100 mean across 3 task(s))

## Score matrix

| Variant | Code Quality /30 | Testing /40 | Security /20 | Docs /10 | **Total /100** |
| --- | --- | --- | --- | --- | --- |
| naked | 25 | 17.3 | 11.3 | 6.7 | **60.3** |
| gstack | 25.3 | 8 | 11 | 6.7 | **51** |
| agentic-os ⚠️ | 18 | 15.3 | 9 | 5.3 | **47.7** |

## Consistent strengths / weaknesses

- **Code Quality**: strongest `gstack` (25.3/30), weakest `agentic-os` (18/30).
- **Testing Coverage**: strongest `naked` (17.3/40), weakest `gstack` (8/40). ⚠️ All variants scored below half — a systematic weakness on this dimension.
- **Security Quality**: strongest `naked` (11.3/20), weakest `agentic-os` (9/20).
- **Documentation**: strongest `gstack` (6.7/10), weakest `agentic-os` (5.3/10).

## Run metrics (not scored)

_Observed cost/time, summed across each (variant × model)'s task(s). NOT part of the /100 score._

| Variant | Model | Exec time (s) | Exec cost (USD) | Input tok | Output tok | Turns | Judge cost (USD) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| naked | sonnet | 467.3s | $1.8927 | 0.2k | 34.7k | 81 | $0.6854 |
| gstack | sonnet | 503.1s | $2.9257 | 1.0k | 37.7k | 83 | $0.6553 |
| agentic-os | sonnet | 1890.3s | $5.3396 | 0.1k | 14.3k | 39 | $0.6680 |

## Per-variant detail

### naked — task `db-column-feature` — model `sonnet`

## Scores

- **Code Quality**: 25/30 — Changes are idiomatic and consistent with existing patterns: a `PRIORITIES` constant drives whitelist validation, the frontend reuses the safe `appendCell` helper, and schema/migration/API/UI all mirror how existing fields are modeled. Minor nit: the default `Medium` is duplicated across schema, server default, and form selected option rather than centralized.
- **Testing Coverage**: 7/40 — No test framework or test files exist or were added; verification was only manual curl/`migrate status` calls shown in the transcript. Per the rubric's critical rule, behavior-changing work without any tests caps this dimension at 10.
- **Security Quality**: 8/20 — Input is validated against a strict whitelist and rendering uses `textContent` (XSS-safe), so no vulnerability was introduced; however the agent performed no visible dedicated security review/threat-modeling step, so the cap of 8 applies.
- **Documentation**: 8/10 — README's data-model and API tables were meaningfully updated to include the `priority` field, allowed values, default, and request body, keeping docs in sync with the change.

**Total Score: 48/100**

## Summary
A clean, idiomatic feature addition that correctly threads `priority` through schema, migration, API validation, and frontend while preserving existing safe-rendering and validation patterns, with good README updates. The critical gap is the complete absence of automated tests despite behavior-changing validation logic, capping testing at 10. Security handling is sound in practice (whitelist + textContent) but no explicit security review was conducted, capping that dimension at 8.

---

### naked — task `prisma-tx-deadlock` — model `sonnet`

## Scores

- **Code Quality**: 23/30 — The three-phase split (conditional updateMany claim, external call outside any transaction, short atomic commit) is idiomatic Prisma, well-named, and the rewritten JSDoc clearly explains intent; minor deductions for the redundant findUnique-then-updateMany and an unhandled process-death window between the card charge and the final commit (card charged, no ledger, order stuck in 'processing').
- **Testing Coverage**: 7/40 — No test framework or test files were created or updated—verification was done entirely via the pre-existing load harness plus throwaway bash scripts that the agent then deleted ('clean up test artifacts'), so nothing repeatable remains; the rubric's rule caps this dimension at 10 for behavior changes without tests.
- **Security Quality**: 7/20 — No new injection or secret-handling issues (Prisma parameterizes queries) and the claim-guard is a sound money-safety mechanism, but there was no explicit security/threat-modeling step and the compensating reset-to-pending on chargeCard failure can double-charge on an ambiguous processor error, while error responses now leak internal order status—cap applies at 8.
- **Documentation**: 6/10 — The JSDoc on chargeOrder was substantially rewritten to explain the new three-step design and the atomicity rationale, which is genuinely useful inline documentation, but no README or external docs were updated despite the README being central to the task setup.

**Total Score: 43/100**

## Summary
A competent, well-reasoned concurrency fix that correctly diagnoses the held-lock/serialized-transaction root cause and implements a clean atomic-claim pattern with thorough inline documentation and strong manual verification. However, it ships zero automated tests (verification scripts were deleted), performed no explicit security review, and leaves a residual crash-window and ambiguous-failure double-charge risk. Solid engineering undermined chiefly by the absence of any durable test suite.

---

### naked — task `safe-redirect` — model `sonnet`

## Scores

- **Code Quality**: 27/30 — Clean, idiomatic TypeScript with clear separation between resolver and handler, named constants instead of magic values, and excellent inline comments explaining each defense (backslash normalization, control-char stripping). Minor duplication: the allowlist is hardcoded in the handler while the resolver takes it as a parameter.
- **Testing Coverage**: 38/40 — Uses the appropriate node:test framework with 19 well-organized cases covering happy paths (relative, https, http, case-insensitivity, normalization) plus every rejection category (javascript:, data:, protocol-relative, backslash tricks, embedded credentials, ftp, control-char smuggling), and tests were actually run and pass via npm test.
- **Security Quality**: 19/20 — This security-critical open-redirect logic is thoroughly hardened; the agent even ran a Bash probe to confirm URL parser leniency before coding, and defends against credential-embedding, protocol-relative, control-char, and backslash variants with secure defaults. No high/critical issues introduced.
- **Documentation**: 6/10 — Strong JSDoc on the exported function and handler plus explanatory inline comments and a clear final summary, but no README or usage doc was created despite the project being greenfield.

**Total Score: 90/100**

## Summary
An exemplary implementation of a security-sensitive redirect resolver: idiomatic, well-factored TypeScript backed by a comprehensive node:test suite that was executed and passes. The agent visibly reasoned about attack vectors (verified parser behavior, defended against smuggling/credentials/backslash tricks) making the security posture strong. The only real gaps are the absence of a README and a minor allowlist duplication in the handler.

---

### gstack — task `db-column-feature` — model `sonnet`

## Scores

- **Code Quality**: 26/30 — Changes are minimal, idiomatic, and consistent with existing patterns: whitelist constant PRIORITIES, validation mirroring the title/description checks, schema default, and appendCell reuse for safe rendering. No duplication or structural issues introduced.
- **Testing Coverage**: 8/40 — No test framework or test files were created; verification was only ad-hoc manual curl calls in the transcript. Per the rubric's critical rule, behavior-changing work with no test files caps this dimension at 10, and the absence of any persistent regression coverage warrants below that.
- **Security Quality**: 8/20 — The change is sound (whitelist validation of priority, server-side default, preserved textContent-based rendering that avoids XSS), but there is no visible deliberate security review step, so this is capped at 8.
- **Documentation**: 8/10 — README data-model and API tables were meaningfully updated to document the new priority field, its allowed values, default, and inclusion in the POST body.

**Total Score: 50/100**

## Summary
A clean, idiomatic feature implementation that correctly threads priority through schema, migration, API validation, seed data, frontend, and docs, with safe whitelist validation and XSS-safe rendering preserved. The critical gap is testing: no test framework or files were added—only manual curl verification—so the heaviest-weighted dimension is capped. Security was handled well in practice but no explicit review step was performed.

---

### gstack — task `prisma-tx-deadlock` — model `sonnet`

## Scores

- **Code Quality**: 24/30 — Clean, idiomatic fix with excellent explanatory comments, an atomic conditional claim (updateMany with status guard), and a short commit-only transaction; minor concern is the polling-based joinInFlightCharge and orders potentially stuck in 'processing' on a mid-charge crash with no reaper, plus magic timeout constants.
- **Testing Coverage**: 8/40 — No test framework or persistent test files were created or updated; the agent wrote an ad-hoc verification script and then deleted it, relying on the pre-existing load harness, so this behavior change ships with no regression-catching tests (rubric caps at 10).
- **Security Quality**: 7/20 — The change correctly addresses the money-safety double-charge correctness issue and introduces no injection/secrets, but there is no visible dedicated security/threat-modeling step and the reasoning is framed around concurrency correctness rather than security review, so this is capped.
- **Documentation**: 6/10 — Strong inline docstrings/comments explaining root cause and invariants plus a schema field comment and a thorough root-cause writeup, but no README or external doc update despite the README being central to the task.

**Total Score: 45/100**

## Summary
A well-reasoned, idiomatic fix that correctly diagnoses the transaction-spanning-external-call anti-pattern and the fake double-charge guard, replacing them with an atomic conditional claim and a short atomic commit. The main weakness is the complete absence of persistent automated tests for a money-critical behavior change, plus no explicit security review and no lasting documentation update. Code quality and the explanation are the clear strengths.

---

### gstack — task `safe-redirect` — model `sonnet`

## Scores

- **Code Quality**: 26/30 — Clean, idiomatic TypeScript with clear separation (resolver vs handler), well-named helpers (tryParseUrl, isAcceptableAbsoluteUrl), named constants instead of magic values, and thoughtful JSDoc explaining the dummy-base parsing trick. Structural RequestLike/ResponseLike types to avoid a hard express dependency is a nice touch.
- **Testing Coverage**: 8/40 — No test framework or test files were created or committed; verification was done via ephemeral Bash scripts that were then deleted. Per the rubric, logic-heavy work with no test files caps this dimension at 10, and nothing durable remains to catch regressions.
- **Security Quality**: 18/20 — The agent explicitly reasoned about open-redirect vectors and manually exercised ~20 attack cases (//evil.com, /\evil.com backslash smuggling, embedded credentials, javascript:/data: schemes, subdomain confusion like example.com.evil.com); implementation correctly rejects credentials, non-http(s) schemes, and off-allowlist hosts with a safe '/' default.
- **Documentation**: 6/10 — Strong inline JSDoc on both the resolver and handler explaining accepted/rejected inputs and usage, but no README or external usage/architecture doc was added despite the task showcasing realistic use.

**Total Score: 58/100**

## Summary
A well-engineered, security-conscious implementation: the resolver is clean, idiomatic, and demonstrably handles the tricky open-redirect edge cases, with a deliberate security review evident in both comments and the manual test matrix. The critical gap is testing—no test framework or persistent test files exist, only throwaway Bash verification—which caps the heaviest dimension. Documentation is limited to good inline comments with no README.

---

### agentic-os — task `db-column-feature` — model `sonnet`

## Scores

- **Code Quality**: 26/30 — Changes are minimal, idiomatic, and consistent with existing patterns: `ALLOWED_PRIORITIES` const keeps the check and error message in sync, validation mirrors the title/description style, and the frontend select/column follow schema field order. No over-abstraction, clean separation.
- **Testing Coverage**: 8/40 — No test framework or test files were created; verification was only manual curl smoke tests against a running server. Since behavior/logic was modified with zero automated tests, the rubric caps this dimension at 10.
- **Security Quality**: 8/20 — Input is properly validated (allow-list for priority, trimming for text) and XSS is avoided via text-node rendering, but no explicit security review or threat modeling step is visible; the app-layer-only enforcement gap was noted for documentation, not as a security assessment. Capped at 8 for absence of a visible security review.
- **Documentation**: 9/10 — README data-model and API tables were accurately updated to include `priority`, and a detailed DATA_MODEL.md was created documenting the persistence shape, both endpoints, validation rules, and the app-vs-DB enforcement caveat.

**Total Score: 51/100**

## Summary
A clean, tightly-scoped implementation that threads the priority field through schema, migration, API validation, and frontend idiomatically, with strong documentation (README + new DATA_MODEL.md). The critical weakness is the complete absence of automated tests—only manual curl smoke tests were performed—which caps testing coverage. No explicit security review was conducted, though the code itself uses secure input validation and safe rendering.

---

### agentic-os — task `prisma-tx-deadlock` — model `sonnet`

> ⚠️ Executor failed: Executor timed out and the container was killed.

## Scores

- **Code Quality**: 0/30 — Executor run failed; no output to score.
- **Testing Coverage**: 0/40 — Executor run failed; no output to score.
- **Security Quality**: 0/20 — Executor run failed; no output to score.
- **Documentation**: 0/10 — Executor run failed; no output to score.

**Total Score: 0/100**

## Summary
Run failed: Executor timed out and the container was killed.

---

### agentic-os — task `safe-redirect` — model `sonnet`

## Scores

- **Code Quality**: 28/30 — Idiomatic TypeScript using WHATWG URL parsing, well-named symbols, thoughtful comments explaining the sentinel-base origin check and host-vs-hostname distinction; allowlist injected for testability and origin constant hoisted to module scope. Minor: the runtime `typeof !== string` guard is dead code under the type signature, though justified as a JS-boundary guard.
- **Testing Coverage**: 38/40 — Two test files using node:test cover happy paths plus an extensive threat model — protocol-relative, backslash/control-char smuggling, embedded credentials, case-insensitivity, port confusion, dot-segment normalization, non-string/array inputs, and handler-level coercion; 20 tests all passing. Falls just short of top only because tests rely on the built-in runner rather than a richer framework and some assertions are terse.
- **Security Quality**: 19/20 — Two visible review agents (security + code) ran; security review empirically tested ~30 bypass classes against the compiled module and found the port-confusion gap, which was then fixed by switching to URL.host with a regression test. Secure fail-closed defaults throughout and no echoing of raw attacker input.
- **Documentation**: 7/10 — Thorough JSDoc on the exported function and handler plus explanatory inline comments on the security-critical logic; no standalone README, but inline docs are strong for a task of this size.

**Total Score: 92/100**

## Summary
A high-quality, security-focused implementation of a safe redirect resolver with idiomatic TypeScript, secure fail-closed defaults, and comprehensive test coverage of the open-redirect threat model. A genuine security review was performed that caught and fixed a real port-confusion hardening gap. Only minor deductions for a dead-code guard and absence of a README.
