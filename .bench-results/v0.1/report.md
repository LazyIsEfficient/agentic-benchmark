# CLAUDE.md Variant Benchmark Report

- **Run ID**: `72c0c43d-4cf1-42c2-adc2-fc67679dfc0f`
- **Task**: Fix payment failures & double-charges under concurrent load, Implement resolveSafeRedirect + Express handler, Harden payment webhook ingestion (signature, replay, idempotency) (`prisma-tx-deadlock,safe-redirect,webhook-hardening`)
- **Executor model(s)**: sonnet
- **Judge model (fixed)**: opus
- **Generated**: 2026-07-09T02:17:38.681Z
- **Top result**: `agentic-os` (82/100 mean, 3/3 scored)

## Score matrix

| Variant | Code Quality /30 | Testing /40 | Security /20 | Docs /10 | **Total /100** | Scored |
| --- | --- | --- | --- | --- | --- | --- |
| agentic-os | 27.7 | 28.7 | 18.3 | 7.3 | **82** | 3/3 scored |
| gstack | 26.7 | 28 | 16.7 | 7.3 | **78.7** | 3/3 scored |
| naked | 24.3 | 18.3 | 14 | 6.7 | **63.3** | 3/3 scored |

## Excluded cells (not scored)

_None — every attempted cell produced a judged result._

## Consistent strengths / weaknesses

- **Code Quality**: strongest `agentic-os` (27.7/30), weakest `naked` (24.3/30).
- **Testing Coverage**: strongest `agentic-os` (28.7/40), weakest `naked` (18.3/40).
- **Security Quality**: strongest `agentic-os` (18.3/20), weakest `naked` (14/20).
- **Documentation**: strongest `agentic-os` (7.3/10), weakest `naked` (6.7/10).

## Run metrics (not scored)

_Observed cost/time, summed across each (variant × model)'s task(s). NOT part of the /100 score._

| Variant | Model | Exec time (s) | Exec cost (USD) | Input tok | Output tok | Turns | Judge cost (USD) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| agentic-os | sonnet | 1565.4s | $9.0155 | 9.9k | 152.0k | 83 | $0.5926 |
| gstack | sonnet | 616.1s | $3.4472 | 2.9k | 54.1k | 90 | $0.3851 |
| naked | sonnet | 461.6s | $2.1479 | 2.9k | 41.0k | 89 | $0.3000 |

## Behavioral signals (not scored)

_What each run actually did — sub-agent usage, tool calls, and diff shape. Observational only; these prove different CLAUDE.md variants produce genuinely different behavior, not just different scores._

### Task: `prisma-tx-deadlock`

| Variant | Sub-agents | Tool calls | Files (src/test/docs) | LOC ± | Tests added | Diff hash |
| --- | --- | --- | --- | --- | --- | --- |
| agentic-os | 2 (code-reviewer, security-reviewer) | 60 | 2/0/0 | +62/-13 | 0 | `bbba6e02` |
| gstack | 0 | 36 | 4/0/0 | +78/-30 | 0 | `b9fdb6d7` |
| naked | 0 | 21 | 1/0/0 | +41/-14 | 0 | `6800f4f4` |

### Task: `safe-redirect`

| Variant | Sub-agents | Tool calls | Files (src/test/docs) | LOC ± | Tests added | Diff hash |
| --- | --- | --- | --- | --- | --- | --- |
| agentic-os | 1 (security-reviewer) | 56 | 5/2/0 | +698/-3 | 24 | `a4443ffa` |
| gstack | 0 | 15 | 3/1/0 | +251/-0 | 19 | `d65fb479` |
| naked | 0 | 21 | 2/1/0 | +122/-0 | 12 | `068a1292` |

### Task: `webhook-hardening`

| Variant | Sub-agents | Tool calls | Files (src/test/docs) | LOC ± | Tests added | Diff hash |
| --- | --- | --- | --- | --- | --- | --- |
| agentic-os | 4 (engineer, data-model-documenter, security-reviewer, code-reviewer) | 169 | 8/2/2 | +447/-24 | 13 | `1077b55d` |
| gstack | 0 | 36 | 8/1/1 | +353/-33 | 7 | `17d67b40` |
| naked | 0 | 44 | 7/0/1 | +147/-32 | 0 | `58fb1ffb` |

## Per-variant detail

### agentic-os — task `prisma-tx-deadlock` — model `sonnet`

## Scores

- **Code Quality**: 27/30 — The CAS `updateMany` claim + split-transaction design is idiomatic, well-named, and cleanly separates the atomic claim, the external call, and the atomic commit; the docstring was rewritten to accurately explain the new invariant and failure handling. Only minor smell is the standalone blanket-500 handler still echoing err.message.
- **Testing Coverage**: 9/40 — No automated test file was created or updated — the existing `test/harness.test.mjs` remains a trivial 1+1 smoke check that imports nothing from src. Verification was done only via a manual load harness and a temporary throwaway hook, and both review agents explicitly flagged the missing regression test; the rubric caps behavior-changing work without test files at 10.
- **Security Quality**: 17/20 — A genuine security/threat review was performed via a dedicated security-reviewer agent, which caught the critical stranded-order regression that the agent then fixed (chargeCard failure now transitions to `failed`). No injection/authz/secret issues introduced; the only residual is the unchanged 500 handler echoing error messages, noted but not fully closed.
- **Documentation**: 6/10 — Inline documentation was meaningfully updated — the docstring accurately describes the new three-phase flow and atomicity scope, and comments explain the out-of-transaction rationale — but no README or external docs were touched and the accepted crash trade-off lives only in the chat summary, not the codebase.

**Total Score: 59/100**

## Summary
A high-quality, correct fix: the CAS claim eliminates the double-charge race and moving the processor call outside the transaction resolves the P2028 timeouts, with a thoughtful failed-state handler added after the security review surfaced a real regression. The work is let down primarily by the absence of any automated regression test — the only proof of the fix is a manual load harness both reviewers criticized — and by documentation confined to inline comments. Security consideration was strong and visible, making this solid engineering marred mainly by testing debt.

---

### agentic-os — task `safe-redirect` — model `sonnet`

## Scores

- **Code Quality**: 28/30 — safeRedirect.ts is clean, well-factored with named constants (SAFE_FALLBACK, ALLOWED_PROTOCOLS, PLACEHOLDER_ORIGIN), small helpers (tryParseUrl, isAllowedAbsoluteUrl), and excellent explanatory comments on non-obvious security logic; the structurally-typed Express handler avoids a hard express dependency. Only minor nitpicks like a dead-branch simplification noted during work.
- **Testing Coverage**: 39/40 — Uses node:test framework with 25 tests at verified 100% coverage covering happy paths, allowlist rejection, subdomain rejection, javascript:/data: schemes, protocol-relative, backslash and tab-mangled host escapes, embedded credentials on both allowlisted and non-allowlisted hosts, dot-segment normalization, and non-string input; tests run against compiled dist output which is well-wired.
- **Security Quality**: 19/20 — An explicit adversarial security-reviewer agent was dispatched and reported concrete reproductions for open-redirect, credential-leak, and dangerous-scheme vectors with a pass verdict; the implementation uses fail-closed defaults, WHATWG origin-equality checks, and exact-match allowlisting with no introduced vulnerabilities.
- **Documentation**: 7/10 — Thorough inline JSDoc and security-rationale comments in source plus a clear final delivery summary, but no README or standalone usage/architecture doc was created despite it being reasonable for a reusable security utility.

**Total Score: 93/100**

## Summary
A strong, security-conscious implementation of a safe redirect resolver with idiomatic TypeScript, a dependency-free Express-style handler, and an exemplary test suite (25 tests, 100% coverage) exercising real bypass vectors. The agent performed a genuine adversarial security review with concrete reproductions and fail-closed design. Only gap is the absence of user-facing documentation like a README.

---

### agentic-os — task `webhook-hardening` — model `sonnet`

## Scores

- **Code Quality**: 28/30 — Clean separation: verification isolated in a pure, JSDoc'd `verifyWebhookSignature.mjs` returning a discriminated result; idempotency via P2002 catch-and-fetch in the service; raw-body capture via express.json verify hook. Length guard before timingSafeEqual, no magic numbers (ALLOWED_SKEW_SECONDS constant), consistent ESM style. Minor: 500 handler still echoes err.message/code/name (pre-existing) and skew constant isn't shared with README.
- **Testing Coverage**: 38/40 — Uses node:test appropriately with two suites: pure-unit coverage of verify (valid, missing secret, malformed ts/sig, wrong-length no-throw, skew boundary at exactly 300s and 301s) plus integration tests driving createApp over real http+fetch covering happy path, missing headers, tampered sig, stale timestamp, sequential replay, and true concurrent 5x duplicate delivery asserting a single row. Would catch real regressions; only minor gap is missing-single-header permutations and non-JSON content-type.
- **Security Quality**: 19/20 — Explicit security review was dispatched (timing-safety, fail-closed paths, raw-body integrity, TOCTOU on P2002, info disclosure, secret leakage) and the agent proactively fixed the flagged JSON-parse stack-trace/path leak. Timing-safe comparison, fail-closed defaults, raw-body-over-exact-bytes, and race-safe idempotency are all correct; only residual is the pre-existing 500 handler echoing error internals and no body-size cap noted.
- **Documentation**: 9/10 — README's insecure section rewritten to the secured contract with signed-request, replay, and rejection curl examples; schema/seed comments updated to match reality; and a thorough DATA_MODEL.md catalogs the PaymentEvent shape, idempotency semantics, headers, and full response-code contract.

**Total Score: 94/100**

## Summary
A thorough, senior-quality hardening: HMAC verification is isolated and timing-safe, idempotency is race-correct via a DB unique constraint plus P2002 handling, and raw-body capture avoids the classic parse/verify mismatch. Testing is the standout — a proper framework with unit + integration + true-concurrency coverage and boundary cases. A dedicated security review was actually performed and its findings acted upon; documentation is comprehensive across README and a generated data model.

---

### gstack — task `prisma-tx-deadlock` — model `sonnet`

## Scores

- **Code Quality**: 26/30 — Clean three-step refactor with a dedicated OrderNotChargeableError class, meaningful constant (CLAIMABLE_STATUS), and excellent explanatory comments; the conditional updateMany claim and short atomic commit reflect thoughtful senior-level design with no god classes or magic values.
- **Testing Coverage**: 10/40 — No test files were created or updated (changed files are all source); verification was ad-hoc via one-off Bash scripts and an existing `npm test`, so despite genuine behavior changes the rubric's no-new-tests cap applies at 10.
- **Security Quality**: 14/20 — The agent deliberately reasoned about money-safety, double-charge prevention, and atomicity, fixing a real correctness/security defect; minor lingering concern that the route still leaks raw err.message/code to clients (pre-existing, and statusCode mapping was added), but nothing dangerous introduced.
- **Documentation**: 7/10 — Strong inline docstrings on chargeOrder, schema and migration comments explaining the partial unique index, plus a thorough root-cause/fix writeup; no README/API doc update, keeping it short of excellent.

**Total Score: 57/100**

## Summary
A high-quality, idiomatic fix that correctly diagnoses the SQLite single-writer lock-hold-over-network-call root cause and the non-guarding unconditional claim, replacing them with a conditional claim, out-of-lock processor call, short atomic commit, and a DB-level defense-in-depth unique index. Security/correctness (double-charge, atomicity) was clearly and deliberately considered. The main gap is the complete absence of persistent automated tests despite meaningful behavior changes, which caps the heavily weighted testing dimension.

---

### gstack — task `safe-redirect` — model `sonnet`

## Scores

- **Code Quality**: 27/30 — Clean separation across resolver, handler, and barrel export; excellent naming, named constants for SAFE_DEFAULT/PLACEHOLDER_ORIGIN instead of magic strings, and well-reasoned JSDoc. Structural Express interfaces avoid an unnecessary dependency; only minor nit is the nested try/catch flow.
- **Testing Coverage**: 37/40 — Uses the native node:test framework appropriately with 20 well-organized cases covering happy paths plus nearly every attack vector (protocol-relative, backslash, javascript:/data:, embedded creds, userinfo smuggling, suffix spoofing, case-insensitivity) and handler behavior via mock.fn; only slightly short of perfect on things like malformed allowlist inputs.
- **Security Quality**: 18/20 — This is a security-critical open-redirect defense and the agent explicitly threat-modeled and rejected credential smuggling, host smuggling, non-http schemes, and suffix spoofing with exact case-insensitive allowlist matching; secure default of '/' throughout. Robust, with no notable missed vector.
- **Documentation**: 6/10 — Thorough, well-written JSDoc on every exported symbol plus a usage example in the handler, but no README or standalone doc was added despite being an empty project where a usage overview would help.

**Total Score: 88/100**

## Summary
A strong, idiomatic TypeScript implementation of a safe redirect resolver with clear separation of concerns and thoughtful defensive coding against the full range of open-redirect vectors. Testing is the standout: the native node:test suite comprehensively exercises happy paths, attack vectors, and the Express handler. Security was visibly and competently considered; the only real gap is the lack of README-level documentation.

---

### gstack — task `webhook-hardening` — model `sonnet`

## Scores

- **Code Quality**: 27/30 — Clean separation into a dedicated webhookAuth.mjs helper with thorough JSDoc, sensible constants (SIGNATURE_PREFIX, DEFAULT_SKEW_SECONDS), and idiomatic P2002 handling; the raw-body verify hook is well-commented. Only minor nit: verification error reasons are surfaced to clients.
- **Testing Coverage**: 37/40 — Uses node:test with 7 end-to-end tests against a disposable SQLite DB covering happy path, missing headers, wrong secret, tampered body, stale timestamp, missing WEBHOOK_SECRET, and idempotent retry — exactly the behaviors the task requires, and they verify no ledger row is written on rejection.
- **Security Quality**: 18/20 — Uses timingSafeEqual with a length pre-check, HMAC over exact raw bytes, fail-closed on every missing/malformed input, and enforced replay skew window; the transcript shows deliberate security reasoning. Minor: error reason strings (e.g. 'server missing WEBHOOK_SECRET') are returned to callers, a small info-disclosure smell.
- **Documentation**: 9/10 — README fully rewritten to reflect the authenticated/idempotent contract with a working signed-curl example, a header table, and 401 fail-closed behavior; schema comments and JSDoc were also updated in sync with the code.

**Total Score: 91/100**

## Summary
A near-exemplary hardening change: constant-time HMAC verification, replay protection, DB-enforced idempotency with correct P2002 handling, and raw-body capture, all cleanly factored and fail-closed. Testing is the standout — a proper node:test suite covering the full matrix of auth/replay/idempotency edge cases with ledger-side assertions. The only quibbles are minor (verification reasons echoed to clients); documentation and code quality are both strong.

---

### naked — task `prisma-tx-deadlock` — model `sonnet`

## Scores

- **Code Quality**: 24/30 — The fix is idiomatic, well-named, and the compare-and-swap via updateMany plus a narrow post-charge $transaction is a clean, correct pattern with excellent explanatory comments; minor deduction because the failure-recovery path can still leave an order stuck in 'processing' if the process dies between a successful chargeCard and the final transaction.
- **Testing Coverage**: 10/40 — No test files or test framework were added or updated despite a behavior/logic change; verification was done only via ad-hoc bash load-test runs, so the critical rule caps this dimension at 10.
- **Security Quality**: 7/20 — No injection or secret issues introduced and Prisma queries are parameterized, but the task is money-safety/security-relevant and the agent performed no explicit security-review or threat-modeling step, so it is capped at 8.
- **Documentation**: 6/10 — The function's JSDoc/doc comment was meaningfully rewritten to explain the CAS guard, connection model, and atomicity reasoning, and the summary explains root cause well, but no README or external docs were updated.

**Total Score: 47/100**

## Summary
A technically strong, well-reasoned fix that correctly diagnoses both the P2028 connection-contention bug and the missing compare-and-swap double-charge guard, with clear commit-atomicity preservation and thorough manual verification. However, no automated tests or test framework were added despite a clear behavior change, and there is no visible security-review step on money-safety-critical code, which caps both weighted dimensions. Documentation is limited to an updated inline doc comment.

---

### naked — task `safe-redirect` — model `sonnet`

## Scores

- **Code Quality**: 22/30 — The visible redirectHandler.ts is clean and well-structured, using minimal structural interfaces to avoid an express dependency and clear JSDoc; however the core resolveSafeRedirect.ts rendered as binary and cannot be directly inspected, so architecture is inferred from tests and the summary.
- **Testing Coverage**: 36/40 — Uses the idiomatic node:test framework with 13 well-organized cases covering happy paths plus a strong set of attack vectors (protocol-relative, backslash tricks, credentials, control chars, host-suffix confusion, malformed input) and tests both the resolver and the handler; npm test reportedly passes 13/13.
- **Security Quality**: 17/20 — The transcript shows a deliberate, thorough security review enumerating and empirically verifying real-world open-redirect bypasses (backslash normalization, credential smuggling, control-character scheme smuggling, suffix confusion) with exact-hostname matching; slight cap on full marks since the actual resolver source could not be directly verified.
- **Documentation**: 5/10 — Good JSDoc with usage examples on the handler, but no README or architecture note was added and the core resolver's documentation is not visible.

**Total Score: 80/100**

## Summary
A well-executed security-focused task: the agent produced a clean Express handler and an exceptionally thorough test suite covering the required attack vectors, and the transcript demonstrates a genuine, evidence-driven security review of open-redirect bypasses. The main limitation is that the core resolveSafeRedirect.ts appears as binary in the diff and could not be directly inspected, and no README/high-level docs were added. Overall a strong, senior-quality deliverable.

---

### naked — task `webhook-hardening` — model `sonnet`

## Scores

- **Code Quality**: 27/30 — Clean separation: signature verification isolated in src/lib/signature.mjs, raw-body capture in app.mjs, idempotency in the service layer. Good naming, timingSafeEqual, strict input validation via regex, and clear comments. Only minor nit: the P2002 catch relies on a magic string error code and there's a small TOCTOU/find-after-create pattern, but both are idiomatic for Prisma.
- **Testing Coverage**: 9/40 — No automated test files were created or updated for the new signature/replay/idempotency logic despite the task being logic-heavy; verification was done only via ad-hoc curl/manual bash scripts and re-running a pre-existing suite. Per the rubric's critical rule (behavior added, no test framework files created/updated), this dimension is capped at 10.
- **Security Quality**: 18/20 — Strong security posture: HMAC over raw bytes, timingSafeEqual constant-time comparison, strict header format validation, fail-closed on missing secret/headers/skew, generic 401 to avoid an oracle while logging reasons server-side. The agent explicitly reasoned about security (avoiding oracle leakage, fail-closed, raw-body integrity) in the transcript.
- **Documentation**: 9/10 — README meaningfully updated: replaced 'insecure' section with authenticated contract, added a working signed-curl example, documented 401 rejection and idempotency semantics; schema/inline comments also updated accurately.

**Total Score: 63/100**

## Summary
A high-quality, idiomatic hardening of the webhook endpoint with correct HMAC verification, constant-time comparison, fail-closed replay protection, and DB-enforced idempotency, plus solid README updates and visible security reasoning. The glaring weakness is testing: no automated test files were added for the new security-critical logic—only manual curl checks—so the heaviest-weighted dimension is capped. Fixing that (unit tests for signature.mjs and an integration test for idempotency/replay) would make this exemplary.
