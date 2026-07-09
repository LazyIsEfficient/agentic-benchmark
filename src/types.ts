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
 * Deterministic anchor configuration for a task — a discriminated union keyed by
 * `kind` so future anchor scenarios add a new member without touching existing
 * consumers: {@link MoneyCentsAnchor} (re-derivable convention), plus two whose
 * knowledge is NOT re-derivable from code — {@link SetupGotchaAnchor} (a runtime
 * gotcha) and {@link RegistryAnchor} (an arbitrary registry rule).
 */
export type AnchorConfig = MoneyCentsAnchor | SetupGotchaAnchor | RegistryAnchor;

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
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
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

/** One dimension's score plus the judge's justification. */
export interface DimensionScore {
  score: number;
  justification: string;
}

/** The four dimensions the judge returns, plus its review determination + summary. */
export interface JudgeResult {
  codeQuality: DimensionScore;
  testingCoverage: DimensionScore;
  securityQuality: DimensionScore;
  documentation: DimensionScore;
  /**
   * The judge's own determination of whether a visible security review was
   * performed. Drives the deterministic security cap (semantic judgment, not
   * mechanically checkable). Defaults to true when the judge omits it, so the
   * punitive cap only fires on a positive "no review" signal.
   */
  securityReviewPerformed: boolean;
  /**
   * The judge's determination that the change satisfies the task's
   * `successCriteria`. Only meaningful for correctness-gated tasks; drives the
   * deterministic total cap. Left undefined by the judge for non-gated tasks.
   */
  taskSolved?: boolean;
  summary: string;
}

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
}

/** Records a single deterministic cap that fired after judging. */
export interface AppliedCap {
  dimension: "testingCoverage" | "securityQuality" | "total";
  rawScore: number;
  cappedTo: number;
  reason: string;
}

/** Final scored result for one (variant × task) after cap enforcement. */
export interface VariantTaskResult {
  /** Per-(variant×task×model) id, unique within a run: `task__variant__modelSlug`. */
  cellId: string;
  variant: string;
  taskId: string;
  /** Executor model this run used — a benchmark dimension (variant × task × model). */
  executorModel: string;
  /** Judge model — held FIXED across all runs so scores stay comparable. */
  judgeModel: string;
  /** Scores exactly as the judge returned them. */
  raw: JudgeResult;
  /** Per-dimension scores after deterministic caps. */
  final: {
    codeQuality: number;
    testingCoverage: number;
    securityQuality: number;
    documentation: number;
  };
  /** Sum of the four final scores. Computed by the harness, not the judge. */
  total: number;
  /** Any caps that were applied (empty when none fired). */
  appliedCaps: AppliedCap[];
  /** Signals used for capping and transparency. */
  signals: {
    /** Mechanical: a test file was created/updated (drives the testing cap). */
    testFilesPresent: boolean;
    /** The judge's determination (drives the security cap). */
    securityReviewPerformed: boolean;
    /** The judge's determination (drives the total cap); undefined for non-gated tasks. */
    taskSolved?: boolean;
    changedFiles: ChangedFile[];
  };
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
   * lack it. Never folded into the /100 score — a separate, mechanical signal.
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
   * Only scored cells fold into the /100 mean; excluded cells are coverage gaps,
   * never a fabricated 0. Stamped onto report.json at write time; derived from
   * executorFailure/judgeFailure so it recomputes on regenerate.
   */
  scored?: boolean;
  /** Why an unscored cell was excluded (timeout / executor / judge failure). */
  excludedReason?: string;
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
}
