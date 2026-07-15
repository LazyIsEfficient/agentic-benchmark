/** Variant kind. `claude-md` = a lone CLAUDE.md; `bundle` = CLAUDE.md + .claude/ tree. */
export type VariantType = "claude-md" | "bundle";

/**
 * How a bundle installs its config into the workspace:
 * - `copy`  — a vendored `.claude/` tree is copied in (agentic-os).
 * - `setup` — a setup command (baked in the image) registers skills at runtime
 *   into `<workspace>/.claude` before the executor runs (gstack).
 */
export type InstallMode = "copy" | "setup";

/** Parsed `prompts/<name>/variant.json` (absent ⇒ claude-md defaults). */
export interface VariantManifest {
  type: VariantType;
  /** CLAUDE.md filename within the variant dir (default "CLAUDE.md"). */
  claudeMd: string;
  /** `.claude` config-tree dirname within the variant dir (default "claude"). */
  configDir: string;
  /** Bundle install mode (default "copy"). */
  install: InstallMode;
  /** Command run in the setup pre-step container (required when install="setup"). */
  setupCommand?: string;
  description?: string;
}

/** A lone-CLAUDE.md variant: `content` is dropped into the workspace (today's shape). */
export interface ClaudeMdVariant {
  name: string;
  type: "claude-md";
  description?: string;
  /** Verbatim CLAUDE.md content for this variant. */
  content: string;
}

/**
 * A copy bundle: a CLAUDE.md PLUS a vendored `.claude/` tree copied into the
 * workspace at project scope (and excluded from the diff).
 */
export interface CopyBundleVariant {
  name: string;
  type: "bundle";
  install: "copy";
  description?: string;
  /** Absolute host path to the bundle's CLAUDE.md. */
  claudeMdPath: string;
  /** Absolute host path to the vendored `.claude` tree. */
  configDirPath: string;
}

/**
 * A setup bundle: a CLAUDE.md is injected, then a setup command (whose source is
 * baked into the image, not vendored into /work) registers skills into
 * `<workspace>/.claude` in a pre-step container before the executor runs.
 */
export interface SetupBundleVariant {
  name: string;
  type: "bundle";
  install: "setup";
  description?: string;
  /** Absolute host path to the bundle's CLAUDE.md. */
  claudeMdPath: string;
  /** Command executed (cwd=/work) in the setup pre-step container. */
  setupCommand: string;
}

/** A full config bundle — either a copy-in tree or a runtime setup step. */
export type BundleVariant = CopyBundleVariant | SetupBundleVariant;

/** A CLAUDE.md variant under test — either a lone CLAUDE.md or a full bundle. */
export type Variant = ClaudeMdVariant | BundleVariant;

/**
 * One ordered step of a sequential (multi-turn) task. A step's `prompt` is what
 * that step hands the executor when its turn comes; steps run in array order and
 * share one accumulating workspace. Used only by sequential-memory tasks — a
 * single-prompt task (no `steps`) never constructs these.
 */
export interface TaskStep {
  /** The prompt handed to the executor for this step. */
  prompt: string;
  /** Optional human-readable label for the step (e.g. "migrate", "reprice"). */
  id?: string;
  /**
   * Optional task-dir-relative directory whose files are laid over the workspace
   * (overwriting existing files) immediately BEFORE this step runs. Used by the
   * poison scenario: a teammate-style migration replaces the money module between
   * steps so that memory formed by an earlier step ("money is integer cents")
   * becomes stale. The overlay is committed as this step's baseline, so it is
   * never attributed to the agent's own diff. Omit for ordinary steps.
   */
  seedOverlay?: string;
}

/**
 * The numeric convention a money value is expected to be expressed in. The
 * anchor detector reads this to decide which shape counts as "correct" on the
 * final step:
 * - `integer-cents` — a plain integer count of cents (the helping baseline).
 * - `decimal` — a Decimal-typed value (e.g. a Decimal.js / db `numeric` wrapper).
 * - `bigint` — a native `bigint` count of cents.
 */
export type MoneyConvention = "integer-cents" | "decimal" | "bigint";

/**
 * Anchor for the money-cents scenario. Declares which convention the final-step
 * output must use to count as correct, and (optionally) which convention is the
 * known trap. This single shape expresses BOTH variants:
 * - helping — `correctConvention: "integer-cents"`, trap is the migrated type.
 * - poison — the current code has migrated to Decimal/BigInt, so following it is
 *   correct: `correctConvention: "decimal" | "bigint"`, trap is `integer-cents`.
 * One detector consumes this for both by comparing observed final-step output
 * against `correctConvention` (held) and against `trapConvention` (hit the trap).
 */
export interface MoneyCentsAnchor {
  /** Discriminant. */
  kind: "money-cents";
  /** The convention the final step must use to count as correct. */
  correctConvention: MoneyConvention;
  /** The convention that constitutes the known trap, when one is defined. */
  trapConvention?: MoneyConvention;
  /** Step `id` the anchor is evaluated against (default: the last step). */
  evaluatedStepId?: string;
}

/**
 * Anchor for the setup-gotcha scenario. The knowledge under test exists ONLY at
 * runtime: a bundle's memory must have recorded that a required setup command
 * (e.g. `npm run gen-fixtures`) has to be run before the workspace is usable,
 * because skipping it produces a failure the agent cannot predict from static
 * code. Both fields are regex SOURCE strings compiled against the raw NDJSON
 * trace of the final step:
 * - `setupSignal` matches the setup command being executed (the memory HELD).
 * - `trapSignal` matches the runtime failure output hit WITHOUT the setup step
 *   (e.g. `Cannot find .*fixtures\.json`) — the agent fell into the gotcha.
 */
export interface SetupGotchaAnchor {
  /** Discriminant. */
  kind: "setup-gotcha";
  /** Regex source matching the required setup command being run in the trace. */
  setupSignal: string;
  /** Regex source matching the runtime failure hit without the setup step. */
  trapSignal: string;
  /** Step `id` the anchor is evaluated against (default: the last step). */
  evaluatedStepId?: string;
}

/**
 * Anchor for the registry scenario. The knowledge under test is an ARBITRARY,
 * unguessable project convention: after adding an export you must also register
 * it in a specific file (e.g. `src/registry.ts`). Nothing in the code makes this
 * rule re-derivable, so only a bundle whose memory recorded it will comply. The
 * detector holds the convention iff the correct final-step diff MODIFIES
 * `requiredFile`.
 */
export interface RegistryAnchor {
  /** Discriminant. */
  kind: "registry";
  /** Workspace-relative path the correct step-2 diff must modify (the rule). */
  requiredFile: string;
  /** Step `id` the anchor is evaluated against (default: the last step). */
  evaluatedStepId?: string;
}

/**
 * Anchor for the generic rule scenario — the least scenario-specific member,
 * intended for campaign tasks whose "did the memory hold?" test is simply the
 * presence/absence of textual signals in the task's diff. Both fields are regex
 * SOURCE strings compiled against the unified diff:
 * - `required` — every pattern MUST be present for the convention to hold.
 * - `forbidden` — no pattern may be present (each is a trap signal).
 * The convention is HELD iff all `required` match AND no `forbidden` matches; an
 * empty/omitted `required` is vacuously satisfied. Unlike {@link RegistryAnchor}
 * (a single required post-image path) this expresses an arbitrary conjunction of
 * must-appear / must-not-appear signals without a dedicated detector shape.
 */
export interface RuleAnchor {
  /** Discriminant. */
  kind: "rule";
  /** Optional human-readable label for the rule (e.g. "uses shared logger"). */
  label?: string;
  /** Regex sources that must ALL match the diff for the rule to hold. */
  required?: string[];
  /** Regex sources that must NOT match the diff (each is a trap). */
  forbidden?: string[];
  /**
   * Regex sources describing where the rule APPLIES — the code surface that
   * exercises it (e.g. "this diff mints an id"). When present and NONE match a
   * link's own diff, that link never faced the rule, so a graded detector
   * reports `held-by-inertia` (vacuously held) instead of crediting a literal
   * or abstraction hold. Omitted = applicability unknown; grading falls back
   * to the required/forbidden signals alone.
   */
  appliesIf?: string[];
  /**
   * Step `id` the anchor is evaluated against (default: the last step). Shared
   * with the other {@link AnchorConfig} members so generic consumers can read
   * `anchor.evaluatedStepId` without narrowing by `kind`.
   */
  evaluatedStepId?: string;
}

/**
 * Deterministic anchor configuration for a task — a discriminated union keyed by
 * `kind` so future anchor scenarios add a new member without touching existing
 * consumers: {@link MoneyCentsAnchor} (re-derivable convention), plus those whose
 * knowledge is NOT re-derivable from code — {@link SetupGotchaAnchor} (a runtime
 * gotcha), {@link RegistryAnchor} (an arbitrary registry rule), and
 * {@link RuleAnchor} (an arbitrary required/forbidden diff-signal conjunction).
 */
export type AnchorConfig =
  | MoneyCentsAnchor
  | SetupGotchaAnchor
  | RegistryAnchor
  | RuleAnchor;

/**
 * One task in a longitudinal CAMPAIGN — a chain of N related tasks run in one
 * persistent workspace so that memory formed by an earlier task can compound
 * into a later one. This is the RUNTIME shape the runner consumes: `prompt` is
 * the fully-resolved text handed to the executor when this link's turn comes.
 * (The on-disk meta.json DTO instead carries `{ id, file, anchor? }`; the loader
 * reads `file` and resolves it to `prompt`.) Distinct from {@link TaskStep}:
 * campaign links are independently JUDGED and ANCHORED, whereas steps are turns
 * of a single scored task.
 */
export interface CampaignTask {
  /** Optional human-readable label for this link (defaults to its index). */
  id?: string;
  /** The resolved prompt handed to the executor for this link. */
  prompt: string;
  /**
   * Deterministic anchor for this link — a convention its diff must hold. When
   * absent, no anchor verdict is computed for the link.
   */
  anchor?: AnchorConfig;
  /**
   * Per-link override of {@link TaskMeta.expectedSurface}: glob patterns of
   * files THIS link is expected to touch. Campaign links usually have narrower
   * surfaces than the chain as a whole, so blast-radius judging needs the
   * per-link scope, not the campaign-wide one.
   */
  expectedSurface?: string[];
  /**
   * Per-link test command (see {@link TaskMeta.testCommand}). Campaign links
   * accrete code, so later links typically need a wider command than earlier
   * ones — hence per-link, not chain-wide.
   */
  testCommand?: string;
}

/** Task metadata from tasks/<id>/meta.json. */
export interface TaskMeta {
  id: string;
  title: string;
  /** True if the task creates/modifies behavior — enables the testing cap. */
  logicBearing: boolean;
  /** True if the task has security implications — enables the security cap. */
  securityRelevant: boolean;
  /**
   * When present, the task is correctness-gated: the judge must return
   * `taskSolved` and the harness caps the TOTAL when it's false. Free-text of
   * what a correct solution must do (e.g. "must locate and fix the deadlock").
   */
  successCriteria?: string;
  /** Optional seed files (relative paths) copied into the workspace. */
  seedFiles?: string[];
  /**
   * Ordered steps for a sequential-memory task. When absent, this is today's
   * single-prompt task (unchanged behavior). When present, the harness runs each
   * step's prompt in order against one accumulating workspace.
   */
  steps?: TaskStep[];
  /**
   * Deterministic anchor for this task — a convention the final step must hold.
   * When absent, no anchor verdict is computed (today's default).
   */
  anchor?: AnchorConfig;
  /**
   * Ordered links of a longitudinal campaign — a chain of related tasks run in
   * one persistent workspace to measure whether memory compounds across tasks.
   * Distinct from {@link steps}: each link is independently judged AND anchored,
   * where steps are turns of one scored task. When absent, this is today's
   * single-task behavior (unchanged).
   */
  campaign?: CampaignTask[];
  /**
   * Glob patterns of the files the task is EXPECTED to touch. When present,
   * the harness lists every changed file that matches no pattern and hands
   * that list to the judge for blast-radius classification — scope is decided
   * mechanically, the judge only grades the excursions. When absent, no
   * out-of-scope list is computed (every file is in scope).
   */
  expectedSurface?: string[];
  /**
   * When true, the fixture loads via {@link loadTasks} (so integration tests can
   * drive it with a fake executor) but is EXCLUDED from the default `--all`
   * roster. Reserved for synthetic fixtures whose stub prompt yields an empty
   * diff on a real agent run — a dead, quota-burning cell in a live bench. An
   * explicit `--task <id>` still selects it; only the implicit roster skips it.
   */
  testOnly?: boolean;
  /**
   * Shell command run in the workspace container AFTER the executor finishes;
   * its pass/fail is the deterministic Correctness axis. When absent the task
   * has no executable tests and correctness falls back to the judge's hedged
   * {@link CorrectnessAssessment}.
   */
  testCommand?: string;
  /**
   * True when the task CANNOT be deterministically tested in the bench container
   * — its harness needs infra the image lacks (an external DB/service, generated
   * client, or npm-installed deps), or it has no test harness at all. Such a task
   * intentionally declares no {@link testCommand} and is scored by the judge's
   * hedged {@link CorrectnessAssessment} ALONE. The distinction matters to the
   * issue-#9 all-fallback warning: an empty deterministic verdict on a judgeOnly
   * task is EXPECTED, not a misconfiguration, so it must not trip that warning.
   */
  judgeOnly?: boolean;
}

/** A resolved task: metadata + the prompt handed to the executor. */
export interface Task {
  meta: TaskMeta;
  /** Absolute path to tasks/<id>/. */
  dir: string;
  /** Contents of task.md — the prompt given to the agent. */
  prompt: string;
}

/** Classification of a single changed file in the resulting diff. */
export type FileKind = "source" | "test" | "docs";

export interface ChangedFile {
  path: string;
  kind: FileKind;
}

/** One sub-agent dispatch observed in the trace (an `Agent` tool_use block). */
export interface SubAgentDispatch {
  /** The `subagent_type` (enum-like, safe to persist verbatim). */
  type: string;
  /** The free-text `description` label — REDACTED before persistence. */
  description?: string;
}

/**
 * Observed behavioral signals for one executor run — what the run actually
 * *did*, independent of its score. Computed at capture time from the raw NDJSON
 * trace + the redacted diff, then stored on the result so it regenerates. Never
 * scored: purely observational, to prove that different CLAUDE.md variants
 * produce genuinely different behavior.
 */
export interface Behavior {
  /** Sub-agent dispatches (Agent tool_use blocks): total, per-type, and the list. */
  subAgents: {
    count: number;
    byType: Record<string, number>;
    dispatches: SubAgentDispatch[];
  };
  /** Every tool_use block: total count and per-tool-name breakdown. */
  toolCalls: { total: number; byName: Record<string, number> };
  /** File-kind counts plus diff line churn (parsed from the unified diff). */
  changedFileShape: {
    source: number;
    test: number;
    docs: number;
    linesAdded: number;
    linesRemoved: number;
  };
  /** The actual set of changed paths (from changedFiles). */
  touchedFiles: string[];
  /** sha256 hex of the (redacted) diff.patch content — a content fingerprint. */
  diffHash: string;
  /** Count of added `it()`/`test()` calls inside test-file hunks. */
  testCasesAdded: number;
}

/**
 * Token usage for one claude call. Prefer full-session `modelUsage` totals
 * (main agent + subagents) when present; otherwise last-turn `usage`.
 * Ground-truth cost signal on a subscription (where total_cost_usd is only a
 * would-be-API proxy).
 */
export interface ClaudeUsage {
  /**
   * UNCACHED (cache-miss) input tokens only — NOT total context cost. In a
   * multi-turn agent loop most of the prompt is served from the prompt cache
   * and billed under `cacheReadTokens`, so this figure is typically tiny
   * (tens of tokens/turn) and must not be rendered as "total input". Real
   * input context cost = inputTokens + cacheReadTokens + cacheCreateTokens.
   */
  inputTokens: number;
  outputTokens: number;
  /** Input tokens read from the prompt cache — the bulk of context in agent loops. */
  cacheReadTokens: number;
  /** Input tokens written to the prompt cache on first use. */
  cacheCreateTokens: number;
}

/**
 * Observed cost/time for one claude call. `wallMs` is always present
 * (host-measured); the rest come from the CLI result event and may be absent.
 * Never scored — purely observational.
 */
export interface CallMetrics {
  wallMs: number;
  durationMs?: number;
  apiMs?: number;
  numTurns?: number;
  costUsd?: number;
  usage?: ClaudeUsage;
}

/** Per-run KPIs: the executor call, plus the judge call when it ran. */
export interface RunMetrics {
  executor: CallMetrics;
  judge?: CallMetrics;
}

/** Structured result of running one executor invocation. */
export interface RunArtifacts {
  /** Per-(variant×task×model) id, unique within a run: `task__variant__modelSlug`. */
  cellId: string;
  variant: string;
  taskId: string;
  /** Absolute path to the per-run workspace on the host. */
  workspaceDir: string;
  /** Unified diff of everything the agent changed (excludes CLAUDE.md). */
  diff: string;
  /** Every changed/added file with its classification. */
  changedFiles: ChangedFile[];
  /** Human-readable transcript extracted from the NDJSON trace. */
  transcript: string;
  /** True if at least one test file was created/modified. */
  testFilesPresent: boolean;
  /** The executor model alias this run used (benchmark dimension). */
  executorModel: string;
  /**
   * Outcome of the task's optional `testCommand`, run in the workspace
   * container after the executor finished. Absent when the task declares no
   * command — downstream that absence IS the "no executable tests" signal that
   * arms the judge's fail-closed correctness fallback.
   */
  testResults?: TestResults;
  /** Observed executor cost/time (wall-clock + CLI result fields). */
  executorMetrics: CallMetrics;
  /** True if the executor container exited cleanly within the timeout. */
  executorOk: boolean;
  /** True if the executor hit the wall-clock timeout — a terminal, non-retried failure. */
  executorTimedOut: boolean;
  /** Populated when executorOk is false. */
  failureReason?: string;
  /** Observed behavioral signals derived from the trace + diff (never scored). */
  behavior?: Behavior;
}

/**
 * Graded refinement of an anchor verdict — WHY the convention held (or didn't),
 * not just whether. The boolean conventionHeld/hitKnownTrap pair can't tell a
 * run that internalized the rule from one that pattern-matched a nearby literal
 * or simply never touched the anchored surface, and those deserve different
 * credit. Ordered strongest-to-weakest:
 * `held-by-abstraction` > `held-by-literal` > `held-by-inertia` >
 * `held-by-chain` > `drift` > `trap`; `unknown` is the fail-closed value when
 * the detector cannot grade.
 *
 * `held-by-abstraction` requires LINK-LEVEL EVIDENCE that this link consumed an
 * abstraction carrying the convention (not merely that the required markers
 * exist somewhere in the chain's cumulative diff — that alone would let a link
 * doing wrong-way work, or nothing at all, inherit the strongest grade).
 * `held-by-chain` is the honest weaker label for cumulative-only holds where
 * the detector has no applicability signal to adjudicate the link itself.
 */
export type AnchorGrade =
  | "held-by-abstraction"
  | "held-by-literal"
  | "held-by-inertia"
  | "held-by-chain"
  | "drift"
  | "trap"
  | "unknown";

/**
 * Deterministic verdict produced by an anchor detector for one run. Independent
 * of the judge's scores: a mechanical read of whether the run held the required
 * convention on the anchored step and whether it fell into the known trap.
 */
export interface AnchorResult {
  /** True if the final-step output used the anchor's `correctConvention`. */
  conventionHeld: boolean;
  /**
   * For a sequential task, the number of steps taken to first satisfy the
   * convention ("turn green"). Undefined when it never held.
   */
  turnsToGreen?: number;
  /** True if the run adopted the anchor's `trapConvention` (fell for the trap). */
  hitKnownTrap: boolean;
  /** Human-readable justification for the verdict (what was observed). */
  evidence: string;
  /**
   * Graded refinement of conventionHeld/hitKnownTrap (ordering: abstraction >
   * literal > inertia > chain > drift > trap). Optional because it is populated
   * by the wave-2 detector work; existing detectors emit only the booleans.
   */
  grade?: AnchorGrade;
}

/**
 * The six craft dimensions the cell judge scores. Craft is the qualitative
 * residual the deterministic axes can't measure: naming (do identifiers say
 * what things mean), structure (is the change shaped like the codebase),
 * consistency (does it match surrounding conventions), economy (no more code
 * than the task needs), documentation (does the change explain its intent —
 * useful docstrings, README/DATA_MODEL/ADR updates, intent-explaining comments
 * — scored on VALUE, not volume; redundant restatement scores LOW), testing
 * (does the change add meaningful tests exercising the NEW behavior — scored on
 * VALUE, not volume; a logic-bearing change with no tests scores LOW).
 */
export type CraftDimension =
  | "naming"
  | "structure"
  | "consistency"
  | "economy"
  | "documentation"
  | "testing";

/**
 * One craft dimension's value on a 0–4 ordinal scale. `"unknown"` is the
 * fail-closed value for when the judge cannot assess (e.g. empty diff, judge
 * output missing the dimension) — it is NEVER clamped to a number, so an
 * unassessable dimension can't masquerade as a low-but-real score.
 */
export type CraftScoreValue = 0 | 1 | 2 | 3 | 4 | "unknown";

/**
 * One craft dimension's score plus the evidence that earned it. Evidence
 * entries are `"file:line — quote"` strings with quotes capped at 10 words
 * ({@link EVIDENCE_QUOTE_MAX_WORDS} in config), so a verdict is auditable
 * against the diff without letting the judge paste whole hunks.
 */
export interface CraftScore {
  score: CraftScoreValue;
  /** `"file:line — quote"` citations backing the score (quotes ≤10 words). */
  evidence: string[];
}

/** All six craft dimensions for one cell — the judge must score every one. */
export interface CellCraft {
  naming: CraftScore;
  structure: CraftScore;
  consistency: CraftScore;
  economy: CraftScore;
  /**
   * Documentation quality — scored on VALUE, not volume. Useful docstrings,
   * README/DATA_MODEL/ADR updates, and intent-explaining comments score HIGH;
   * redundant restatement of the code or README scores LOW, so the dimension
   * cannot be gamed by padding. Distinct from `economy`: good documentation is
   * NOT the "verbosity" the anti-verbosity rule penalizes.
   */
  documentation: CraftScore;
  /**
   * Testing discipline — scored on VALUE, not volume. Meaningful tests that
   * exercise the NEW behavior (especially edge cases / the hard path the change
   * introduces) score HIGH; a logic-bearing change shipped with NO tests, or
   * trivial/padding/duplicate tests that don't cover the new logic, score LOW,
   * so the dimension cannot be gamed by test COUNT. Distinct from the
   * deterministic test-tamper slop signal (which penalizes WEAKENING existing
   * tests): this rewards ADDING good ones. Like `documentation`, meaningful
   * tests are NOT the "verbosity" the anti-verbosity rule penalizes.
   */
  testing: CraftScore;
}

/**
 * How an out-of-scope file touch is judged. Ordered by escalating severity:
 * - `necessary` — the task genuinely required it (e.g. a shared type).
 * - `defensible` — arguable but reasonable (e.g. a drive-by typo fix).
 * - `overreach` — unrequested scope creep that dilutes the diff.
 * - `adversarial` — gaming the benchmark (e.g. editing tests to pass, touching
 *   harness files); any single adversarial entry hard-disqualifies the cell.
 */
export type BlastClassification =
  | "necessary"
  | "defensible"
  | "overreach"
  | "adversarial";

/**
 * One file the run touched OUTSIDE the task's expected surface, with the
 * judge's read on whether that excursion was warranted. The harness computes
 * the out-of-scope list mechanically (expectedSurface globs vs changedFiles);
 * the judge only classifies — it never decides what counts as out-of-scope.
 */
export interface BlastRadiusEntry {
  /** Workspace-relative path of the out-of-scope file. */
  file: string;
  classification: BlastClassification;
  /** Why this classification (what the change to the file actually does). */
  evidence: string;
}

/**
 * The cell judge's read on whether the change works, used ONLY when a task has
 * no executable tests. `unknown` is deliberate and fail-closed: a judge that
 * cannot tell must say so rather than guess, because "likely" here is already
 * the weakest correctness signal in the system.
 */
export type CorrectnessVerdict = "likely_correct" | "likely_incorrect" | "unknown";

/**
 * The judge's fallback correctness verdict plus the observations behind it.
 * Deliberately hedged naming (`likely_*`): a static read of a diff is not a
 * test run, and downstream scoring must weight it accordingly.
 */
export interface CorrectnessAssessment {
  verdict: CorrectnessVerdict;
  /** What in the diff/transcript supports the verdict. */
  evidence: string[];
}

/**
 * Structured verdict of the cell judge — owns ONLY the qualitative residual;
 * deterministic axes (tests, anchors, telemetry) are computed by the harness
 * and passed to the judge read-only. Replaces the retired weighted-total
 * rubric: instead of four weighted point totals, the judge emits ordinal
 * craft scores, blast-radius classifications, and (when no tests exist) a
 * hedged correctness read — nothing it returns is ever summed.
 */
export interface CellJudgeResult {
  craft: CellCraft;
  /**
   * One entry per file outside the task's expected surface; `[]` when none.
   * Any `"adversarial"` entry hard-disqualifies the cell.
   */
  blastRadius: BlastRadiusEntry[];
  /**
   * Fail-closed fallback used ONLY when the task has no executable tests;
   * null otherwise (the deterministic testCommand verdict wins).
   */
  correctnessAssessment: CorrectnessAssessment | null;
  /** Free-form judge observations that fit no dimension (never scored). */
  flags: string[];
}

/**
 * Mechanical slop signals computed by the harness from the diff — the
 * quantifiable half of the craft/economy story, kept OUT of the judge so it
 * can't be argued with. Each field is a count/ratio a reader can re-derive
 * from the diff by hand.
 */
export interface SlopMetrics {
  /**
   * Count of duplicated added-line windows in the diff (normalized), over
   * PRODUCTION files only — doc and test files are excluded so thoroughness the
   * Craft judge rewards is not double-penalized here (issue #43).
   */
  duplicationDelta: number;
  /**
   * Per-file audit trail for {@link duplicationDelta}: a capped array of the
   * windows that actually repeated, so a bare count can be checked against the
   * source — repetitive production bloat vs. a false positive. Mirrors
   * {@link testTamper}'s evidence. Optional for backward-compat: legacy slop
   * objects (old report.json) lack it; computeSlopMetrics always sets it.
   */
  duplicationEvidence?: { file: string; excerpt: string }[];
  /**
   * Count of ADDED lines from PRODUCTION files (doc/test files excluded) that
   * fed the code-hygiene metrics. 0 means the diff shipped no production code —
   * an all-doc/test cell whose clean metrics would otherwise read as a perfect
   * SlopHealth of 1.0 (and, via the slop-only Craft path, a misleading Craft
   * 100). SlopHealth is null'd when a whole aggregate has zero of these (issue
   * #43). Optional for backward-compat: legacy report.json cells lack it and are
   * treated as HAVING production signal so their SlopHealth is unchanged.
   */
  productionAddedLineCount?: number;
  /**
   * Campaign links only: fraction of lines added by earlier links that this
   * link deletes — high churn means the chain is rewriting its own work.
   * null for single-shot cells, where there is no earlier link to churn.
   */
  churnRatio: number | null;
  /** Leftover work-in-progress artifacts the run shipped in its diff. */
  residue: { todos: number; debugLogging: number; commentedOutCode: number };
  /**
   * Signals that the run weakened tests to pass (skipped/deleted/loosened
   * assertions). Evidence entries cite the offending hunks.
   */
  testTamper: { hits: number; evidence: string[] };
  /**
   * Helper-extraction signal: call-sites in the ADDED lines that REUSE a helper
   * the SAME diff DECLARES (a `function`, arrow, or `function`-expression
   * binding), counted beyond the declaration itself. A run that extracts one
   * helper and calls it from N sites scores N; a run that inlines the same logic
   * N times declares no shared helper and scores 0 — the direct read on the
   * `generateId()`-style drift. Conservative by construction: only identifiers
   * the diff itself defines are ever counted, so ordinary library/framework
   * calls can never inflate it. Optional for backward-compat — legacy slop
   * objects (old report.json) lack it; computeSlopMetrics always sets it.
   */
  helperReuse?: number;
  /**
   * Literal-density signal: count of MAGIC literals inlined in added CODE lines
   * — multi-digit / fractional numbers and non-trivial (≥2-char, non-template)
   * string literals that are NOT the right-hand side of a named-constant
   * declaration (extracting a `const NAME = …` is the healthy pattern and is
   * deliberately excluded, as are comment and import lines). Single-digit
   * integers (0–9) and empty/1-char strings are floored out so ordinary code
   * does not score. Optional for backward-compat (see {@link helperReuse}).
   */
  literalDensity?: number;
}

/**
 * Result of running a task's optional testCommand in the workspace container
 * — the deterministic Correctness axis. Absence on a cell = "no executable
 * tests" (test_results: none), which is what routes the judge to its
 * {@link CorrectnessAssessment} fallback.
 */
export interface TestResults {
  /** The shell command that was run (echoed for auditability). */
  command: string;
  /**
   * Best-effort pass count parsed from the runner output (node:test / jest /
   * vitest summaries). Absent when the output was unparseable — `ok` (exit
   * code) stays authoritative; counts are never fabricated.
   */
  passed?: number;
  /** Best-effort fail count parsed from the runner output; see {@link passed}. */
  failed?: number;
  /** True iff the command exited 0. */
  ok: boolean;
  /** Raw runner output, kept when it fits (for debugging surprising verdicts). */
  raw?: string;
}

/** Which variant won one pairwise comparison (or neither, decisively). */
export type PairwiseWinner = "A" | "B" | "tie";

/**
 * How consequential a pairwise verdict is, so the aggregation can weight a
 * soundness/correctness-relevant win (e.g. catching a real open redirect the
 * other diff shipped) above a purely stylistic nit (an import spelling, a
 * naming preference):
 * - `soundness` — the winning side's edge implicates correctness, security, or
 *   robustness (a real defect avoided, a check the loser omitted).
 * - `style`     — the edge is stylistic/craft-only; the ORDINARY weight.
 *
 * FAIL-CLOSED: a missing/invalid severity degrades to `style` (ordinary weight)
 * — it never manufactures or inflates a preference. Only an explicit
 * `soundness` on a DECISIVE (non-tie) verdict earns the heavier weight.
 */
export type PairwiseSeverity = "soundness" | "style";

/**
 * One craft dimension of an A/B comparison. Evidence is required for BOTH
 * sides — a winner without cited evidence from each diff is unauditable.
 */
export interface PairwiseDimension {
  winner: PairwiseWinner;
  /** `"file:line — quote"` citation from variant A's diff. */
  evidenceA: string;
  /** `"file:line — quote"` citation from variant B's diff. */
  evidenceB: string;
}

/**
 * One A/B craft comparison of two variants' diffs for the same task/link/model
 * (and same repeat index). Pairwise exists because absolute craft scores drift
 * across judge calls; a same-context head-to-head is stabler. variantA/variantB
 * record the RESOLVED mapping after per-call randomization (the A/B order is
 * shuffled per call to cancel position bias), so a reader can always map the
 * winner letter back to a variant name.
 */
export interface PairwiseResult {
  taskId: string;
  /** Campaign link index when comparing campaign links; absent for single-shot. */
  linkIndex?: number;
  /** The executor model both sides ran under (comparisons never cross models). */
  executorModel: string;
  /** 1-based repeat index when comparing --repeats runs; absent otherwise. */
  repeat?: number;
  /** Variant name presented to the judge as "A" (post-randomization). */
  variantA: string;
  /** Variant name presented to the judge as "B" (post-randomization). */
  variantB: string;
  dimensions: {
    naming: PairwiseDimension;
    structure: PairwiseDimension;
    consistency: PairwiseDimension;
    economy: PairwiseDimension;
    documentation: PairwiseDimension;
    testing: PairwiseDimension;
  };
  /**
   * The judge's overall call across the six dimensions, with its reasoning and
   * a severity signal. `severity` is `soundness` only when the winning edge
   * implicates correctness/security/robustness; it degrades to `style` (the
   * ordinary weight) fail-closed, so a malformed field never inflates a
   * preference. A `tie` is always ordinary regardless of severity.
   */
  overall: {
    winner: PairwiseWinner;
    rationale: string;
    severity: PairwiseSeverity;
  };
  /**
   * Set when this comparison was judged in BOTH seatings and combined (issue
   * #36): position bias is cancelled per comparison, so the report's A-slot
   * audit is ~50% by construction rather than a bias signal. Absent ⇒ the
   * single randomized-order path (the A-slot audit is a real bias check).
   */
  bothOrders?: boolean;
  /** Set when the pairwise judge call failed; the comparison is unusable. */
  judgeFailure?: string;
}

/** Scored result for one (variant × task × model) cell. */
export interface VariantTaskResult {
  /** Per-(variant×task×model) id, unique within a run: `task__variant__modelSlug`. */
  cellId: string;
  variant: string;
  taskId: string;
  /** Executor model this run used — a benchmark dimension (variant × task × model). */
  executorModel: string;
  /** Judge model — held FIXED across all runs so scores stay comparable. */
  judgeModel: string;
  /**
   * Structured five-axis judge verdict (craft, blast radius, correctness
   * fallback). Optional for backward-compat: cells judged by the old pipeline
   * — and old report.json files — lack it.
   */
  judge?: CellJudgeResult;
  /** Mechanical slop signals computed from the diff. Optional (see judge). */
  slop?: SlopMetrics;
  /**
   * Deterministic testCommand verdict. Absent = the task declared no
   * testCommand, i.e. "no executable tests" — NOT a failure.
   */
  testResults?: TestResults;
  /**
   * Mirror of {@link TaskMeta.judgeOnly}, stamped onto the cell at scoring time
   * so report rendering (which reads the persisted {@link Report}, not the task
   * metas) can tell an EXPECTED empty deterministic verdict from a #9-style
   * misconfiguration. Absent/false = an ordinary cell whose empty Tests column
   * still counts toward the all-fallback coverage warning.
   */
  judgeOnly?: boolean;
  /**
   * Changed files matching none of the task's expectedSurface globs — the
   * mechanical input to blast-radius judging. Absent when the task declares
   * no expectedSurface; `[]` when everything stayed in scope.
   */
  filesOutsideExpectedSurface?: string[];
  /**
   * True iff any blastRadius entry is `"adversarial"`. A disqualified cell is
   * excluded from every aggregate, not scored low — gaming attempts must not
   * be averaged away.
   */
  disqualified?: boolean;
  /**
   * 1-based repeat index for --repeats runs, so repeated cells of the same
   * (variant × task × model) stay distinguishable. Absent for single runs.
   */
  repeat?: number;
  /** Observed cost/time KPIs for this run. Never scored. */
  metrics: RunMetrics;
  /**
   * Observed behavioral signals (sub-agent usage, tool calls, diff shape).
   * Optional for backward-compat: results in old report.json files lack it and
   * degrade to `—` in the behavior comparison table.
   */
  behavior?: Behavior;
  /**
   * Deterministic anchor verdict for this run, when the task declared an
   * `anchor`. Optional for backward-compat: results in old report.json files
   * lack it. Never folded into any score — a separate, mechanical signal.
   */
  anchors?: AnchorResult;
  /** Set when the executor failed; the run is scored as zero. */
  executorFailure?: string;
  /** Set when the judge failed (container error, timeout, or bad output). */
  judgeFailure?: string;
  /** True if the diff/transcript evidence was truncated to fit the judge context. */
  evidenceTruncated?: boolean;
  /**
   * Whether this cell got a real judge verdict (executorOk AND no judge failure).
   * Only scored cells fold into aggregates; excluded cells are coverage gaps,
   * never a fabricated 0. Stamped onto report.json at write time; derived from
   * executorFailure/judgeFailure so it recomputes on regenerate.
   */
  scored?: boolean;
  /** Why an unscored cell was excluded (timeout / executor / judge failure). */
  excludedReason?: string;
}

/**
 * Scored outcome of ONE link in a campaign chain — the per-task record that lets
 * a trajectory be read link-by-link. Lighter than {@link VariantTaskResult}: the
 * link's five-axis verdict plus its deterministic `anchors` verdict and observed
 * `metrics`, since a campaign's signal is the SHAPE of the curve across links.
 */
export interface CampaignTaskResult {
  /** The link's `id` (or its stringified index when the link had no `id`). */
  taskId: string;
  /** Zero-based position of this link within the campaign chain. */
  index: number;
  /**
   * Structured five-axis judge verdict for this link. Optional for
   * backward-compat: old report.json files and old-pipeline links lack it.
   */
  judge?: CellJudgeResult;
  /** Mechanical slop signals for this link's diff (incl. churnRatio vs earlier links). */
  slop?: SlopMetrics;
  /** Deterministic testCommand verdict. Absent = the link declared no testCommand. */
  testResults?: TestResults;
  /**
   * Changed files matching none of the link's expectedSurface globs. Absent
   * when no expectedSurface applies; `[]` when everything stayed in scope.
   */
  filesOutsideExpectedSurface?: string[];
  /** True iff any blastRadius entry is `"adversarial"` — the link is excluded, not low-scored. */
  disqualified?: boolean;
  /** Deterministic anchor verdict for this link, when it declared an `anchor`. */
  anchors?: AnchorResult;
  /** Observed executor cost/time for this link (never scored). */
  metrics: CallMetrics;
  /** Set when the link failed (executor or judge); the link scores as zero. */
  failure?: string;
}

/**
 * The full trajectory of ONE campaign for one variant × executor model: the
 * ordered per-link results in a single persistent workspace. Downstream report
 * code reads `tasks` in order to chart whether persistent memory compounds
 * (e.g. rising scores / falling turns-to-green across links).
 */
export interface CampaignResult {
  /** The variant under test for this campaign run. */
  variant: string;
  /** The executor model alias this campaign ran under (a benchmark dimension). */
  executorModel: string;
  /** Identifier of the campaign chain (the `TaskMeta.id` that declared it). */
  campaignId: string;
  /**
   * 1-based repeat index for --repeats runs, so repeated campaigns of the same
   * (variant × campaign × model) stay distinguishable. Absent for single runs.
   */
  repeat?: number;
  /** Per-link results in chain order. */
  tasks: CampaignTaskResult[];
}

/** The full report payload written to <runDir>/report.json. */
export interface Report {
  /** Per-execution GUID (crypto.randomUUID), one per `bench` invocation. */
  runId: string;
  generatedAt: string;
  taskId: string;
  taskTitle: string;
  /** Executor models tested (the varying dimension). */
  executorModels: string[];
  /** The fixed judge model used for every run. */
  judgeModel: string;
  results: VariantTaskResult[];
  /**
   * Longitudinal campaign trajectories carried alongside `results`, when the run
   * exercised any campaign task. Optional for backward-compat: single-task and
   * single-shot runs omit it entirely (old report.json files lack the field).
   */
  campaigns?: CampaignResult[];
  /**
   * A/B craft comparisons across variant pairs, when pairwise judging ran
   * (PAIRWISE_ENABLED). Optional for backward-compat: old report.json files
   * and runs with pairwise disabled lack the field.
   */
  pairwise?: PairwiseResult[];
}
