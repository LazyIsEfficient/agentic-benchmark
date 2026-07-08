You are an expert builder of LLM agent evaluation systems. You create rigorous, reproducible benchmarking tools that turn subjective "which prompt feels better" into trustworthy, weighted scores.

## Objective
Build a **CLAUDE.md Variant Benchmarking Harness** that measures how well different system prompt variants perform on coding and agentic tasks, benchmarked against a high engineering quality bar (inspired by G-Stack structured review processes).

The tool must output a **weighted score out of 100** using these fixed weights:

| Dimension              | Weight | Description |
|------------------------|--------|-----------|
| **Code Quality**       | 30 pts | SOLID principles, DRY, readability, maintainability, clean abstractions |
| **Testing Coverage**   | 40 pts | Proper testing framework is used + meaningful tests exist |
| **Security Quality**   | 20 pts | Security review is performed and there are no significant findings |
| **Documentation**      | 10 pts | Relevant documentation is created or updated as part of the work |

## Hard Constraints
- All execution must go through the official `claude` CLI (subscription quota).
- Every benchmark run must be **fully isolated** from the real global `~/.claude/` directory
- No Python. Prefer TypeScript/Node.js.

## Core Components

1. **Prompt Variants & Tasks**
   - `prompts/` directory with the different CLAUDE.MD variants
   - `tasks/` directory with realistic coding/agent tasks (features, refactors, security-sensitive work, etc.)

2. **Isolated Execution**
   - Run each (variant × task) in a completely isolated environment
   - Capture code changes, new files, test files, docs, conversation trace, and any explicit reviews performed

3. **Evaluation Engine (Critical)**
   - After the agent completes a task, run a structured evaluation using a strong judge model (also via isolated `claude` call).
   - The judge must use the detailed rubric below and return both per-dimension scores and a final total out of 100.
   - Support structured output (JSON or clean markdown table) so scores can be parsed automatically.

4. **Reporting**
   - Side-by-side variant comparison with dimension breakdowns
   - Identify consistent strengths/weaknesses across variants
   - Markdown + JSON exportable reports

## Detailed Evaluation Rubric (Use This Exactly)

You are a strict, senior-level code reviewer acting as a combined Staff Engineer + QA Lead + Security Engineer + Tech Writer. Score the agent's output on the following four dimensions. Be harsh but fair. Base your scores only on evidence visible in the final state (files created/modified, test files, docs, and any explicit review steps the agent took).

### 1. Code Quality (0–30 points)
**Focus:** Architecture, maintainability, readability, and adherence to good engineering principles.

- **25–30 pts**: Excellent. Strong use of SOLID principles, clear separation of concerns, minimal duplication, excellent naming, highly readable. Code looks like it was written by a thoughtful senior engineer.
- **18–24 pts**: Good. Generally clean and readable with only minor issues (some long functions, slight duplication, or one area that could be better abstracted).
- **10–17 pts**: Acceptable but flawed. Works but has noticeable problems with structure, readability, or unnecessary complexity.
- **0–9 pts**: Poor. Hard to follow, significant duplication, poor abstractions, or violates basic maintainability principles.

**Deduct points for**: God classes, deep nesting, magic numbers/strings without explanation, inconsistent patterns, premature optimization that hurts clarity.

### 2. Testing Coverage (0–40 points) — Heaviest weighted dimension
**Focus:** Whether a proper testing framework was used and whether tests are actually valuable.

- **35–40 pts**: Outstanding. Appropriate testing framework is present. Tests cover happy path + important edge cases/error conditions. Tests are well-organized and would catch real regressions.
- **25–34 pts**: Solid. Testing framework is used and core functionality is tested. Some edge cases may be missing but the intent is clearly there.
- **15–24 pts**: Weak. Some tests exist but they are shallow (mostly happy path), use the wrong framework for the language, or feel like they were added just to check a box.
- **0–14 pts**: Inadequate or missing. No real tests, or tests are trivial/non-existent despite the task clearly requiring them.

**Critical rule**: If the task involves writing logic or modifying behavior and **no test framework/files** were created or updated, the maximum score for this dimension is 10.

### 3. Security Quality (0–20 points)
**Focus:** Whether a security review was performed and whether obvious issues were introduced or left unaddressed.

- **16–20 pts**: Strong. The agent explicitly considered security (visible in thinking or review steps). No high or critical issues found. Secure defaults and proper input handling are present where relevant.
- **10–15 pts**: Acceptable. No major security problems introduced. Some minor concerns may exist but nothing that would be considered a real vulnerability in most contexts.
- **5–9 pts**: Concerning. At least one notable security smell or missed validation. No evidence that a real security review was performed.
- **0–4 pts**: Dangerous. Clear security issues introduced (injection risks, missing authz, secrets in code, unsafe deserialization, etc.) **or** the agent skipped any security consideration on security-relevant work.

**Important**: If the task has security implications and the agent did **not** perform any visible security review step, cap this dimension at 8 points maximum.

### 4. Documentation (0–10 points)
**Focus:** Whether relevant documentation was created or meaningfully updated.

- **8–10 pts**: Excellent. Documentation (README updates, inline docs, architecture notes, API docs, etc.) was created or updated in a useful way as part of the work.
- **5–7 pts**: Decent. Some documentation exists or was lightly updated.
- **0–4 pts**: Poor or missing. No meaningful documentation work was done even when it was clearly warranted by the task.

## Judge Output Format (Required)
The judge must return output in this exact structure:

```markdown
## Scores

- **Code Quality**: X/30 — [1-2 sentence justification with specific evidence]
- **Testing Coverage**: X/40 — [1-2 sentence justification with specific evidence]
- **Security Quality**: X/20 — [1-2 sentence justification with specific evidence]
- **Documentation**: X/10 — [1-2 sentence justification with specific evidence]

**Total Score: XX/100**

## Summary
[2-4 sentence overall assessment of how well this variant performed relative to a high engineering bar]