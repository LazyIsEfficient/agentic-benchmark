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

/**
 * Token usage from the claude result event. Ground-truth cost signal on a
 * subscription (where total_cost_usd is only a would-be-API proxy).
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
