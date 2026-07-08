import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Repo root (parent of src/). All other paths derive from here. */
export const REPO_ROOT = path.resolve(__dirname, "..");

export const PROMPTS_DIR = path.join(REPO_ROOT, "prompts");
export const TASKS_DIR = path.join(REPO_ROOT, "tasks");
export const REPORTS_DIR = path.join(REPO_ROOT, "reports");

/**
 * Sort horizon for the reverse-time folder key. Each run folder is prefixed with
 * `HORIZON_MS - runEpochMs`, zero-padded, so a plain ascending name sort lists
 * the NEWEST run first (newer run → smaller key). The constant is a round value
 * safely beyond any real run time (~year 2286); as long as runEpochMs < this,
 * the key stays positive and fixed-width.
 */
export const HORIZON_MS = 10_000_000_000_000;

/**
 * Host-side dir for the harness's local state (the OAuth token file). Gitignored.
 * Nothing here is ever bind-mounted into a container — auth reaches containers
 * only via an env var, so the real ~/.claude is never touched.
 */
export const BENCH_CONFIG_DIR = path.join(REPO_ROOT, ".bench-config");

/**
 * Long-lived subscription token model. `claude setup-token` PRINTS a token (it
 * does not persist a credential file); headless/Docker runs supply it via this
 * env var. The harness resolves it from the process env or the token file.
 */
export const OAUTH_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";
export const OAUTH_TOKEN_FILE = path.join(BENCH_CONFIG_DIR, "oauth-token");

/** The variant file name dropped into each workspace and read by claude. */
export const VARIANT_FILENAME = "CLAUDE.md";

/**
 * Project-scope config dir materialized inside a bundle variant's workspace.
 * Claude Code reads `<project>/.claude/` for skills/agents/commands/hooks.
 */
export const WORKSPACE_CONFIG_DIR = ".claude";

/** Docker image name, overridable so CI or forks can retag. */
export const IMAGE_NAME = process.env.BENCH_IMAGE ?? "claude-bench:latest";

/** Config dir path inside the container. Matches the image ENV. */
export const CONTAINER_CONFIG_DIR = "/cfg";

/** Workspace mount point inside the container. */
export const CONTAINER_WORK_DIR = "/work";

/**
 * Model aliases passed to `claude --model`. The executor does the coding work;
 * the judge scores it. A stronger judge than executor is intentional.
 */
export const EXECUTOR_MODEL = process.env.BENCH_EXECUTOR_MODEL ?? "sonnet";
export const JUDGE_MODEL = process.env.BENCH_JUDGE_MODEL ?? "opus";

/** Per-executor-run wall-clock timeout in milliseconds (default 900s). */
export const EXECUTOR_TIMEOUT_MS = Number(
  process.env.BENCH_EXECUTOR_TIMEOUT_MS ?? 900_000,
);

/** Timeout for a bundle's setup pre-step container (default 300s). */
export const SETUP_TIMEOUT_MS = Number(
  process.env.BENCH_SETUP_TIMEOUT_MS ?? 300_000,
);

/** Judge runs are tool-less and fast; give them a tighter default timeout. */
export const JUDGE_TIMEOUT_MS = Number(
  process.env.BENCH_JUDGE_TIMEOUT_MS ?? 300_000,
);

/**
 * Retry budgets for transient container failures (Opus occasionally errors under
 * load). The judge is pure/idempotent so it gets more attempts; the executor
 * mutates its workspace so each retry starts from a fresh one. Env-overridable.
 */
export const JUDGE_MAX_ATTEMPTS = Number(process.env.BENCH_JUDGE_MAX_ATTEMPTS ?? 3);
export const EXECUTOR_MAX_ATTEMPTS = Number(
  process.env.BENCH_EXECUTOR_MAX_ATTEMPTS ?? 2,
);
/** Base backoff in ms; delay after a failed attempt N is RETRY_BASE_MS * 2^(N-1). */
export const RETRY_BASE_MS = Number(process.env.BENCH_RETRY_BASE_MS ?? 2000);

/**
 * Grace period after a run timeout fires: we `docker kill` the container AND
 * SIGKILL the local `docker run` client, but if the client still hasn't emitted
 * `close` within this window we force-resolve the run as timed-out. Bounds total
 * wall-clock to ≈ timeout + grace regardless of how docker behaves.
 */
export const CONTAINER_KILL_GRACE_MS = Number(
  process.env.BENCH_CONTAINER_KILL_GRACE_MS ?? 10_000,
);

/**
 * Optional pause between benchmark cells (sequential and per pool dispatch) to
 * relieve sustained API rate-limit pressure on large multi-model matrices.
 * Default 0 = no pacing (today's behavior). Overridable per run via --delay-ms.
 */
export const INTER_CELL_DELAY_MS = Number(
  process.env.BENCH_INTER_CELL_DELAY_MS ?? 0,
);

/**
 * Ignore patterns applied to each workspace's .git/info/exclude at prepare time
 * so dependency/build artifacts (e.g. node_modules from a legitimate `npm
 * install`) are never counted as the agent's work. Same mechanism as the
 * CLAUDE.md exclusion — invisible to the agent and robust even if it writes its
 * own .gitignore.
 */
export const WORKSPACE_EXCLUDE_PATTERNS = [
  "node_modules/",
  "**/node_modules/",
  "dist/",
  "build/",
  "coverage/",
  ".next/",
  ".turbo/",
  "*.log",
  ".DS_Store",
] as const;

/**
 * Byte caps on the evidence shown to the judge. Even with node_modules excluded
 * and the prompt sent over stdin (so ARG_MAX is a non-issue), a legitimately
 * huge diff/transcript wastes judge tokens and risks the context limit, so it is
 * truncated with a visible marker. Env-overridable.
 */
export const MAX_DIFF_BYTES = Number(
  process.env.BENCH_MAX_DIFF_BYTES ?? 200_000,
);
export const MAX_TRANSCRIPT_BYTES = Number(
  process.env.BENCH_MAX_TRANSCRIPT_BYTES ?? 200_000,
);

/**
 * Rubric weights (max points per dimension). These are the fixed weights from
 * prompt.md and must sum to 100. Centralized here so no magic numbers leak into
 * scoring or reporting code.
 */
export const DIMENSION_MAX = {
  codeQuality: 30,
  testingCoverage: 40,
  securityQuality: 20,
  documentation: 10,
} as const;

export const TOTAL_MAX = 100;

/** Deterministic cap ceilings applied as a backstop after judging (prompt.md). */
export const TESTING_CAP_WHEN_NO_TESTS = 10;
export const SECURITY_CAP_WHEN_NO_REVIEW = 8;

/**
 * Total-score ceiling applied when a correctness-gated task's core requirement
 * was not met (judge taskSolved=false). Unlike the per-dimension caps, this
 * clamps the headline TOTAL — an agent that never solved the task must not score
 * well no matter how tidy the incidental code was. Env-overridable.
 */
export const CORRECTNESS_CAP_WHEN_UNSOLVED = Number(process.env.BENCH_CORRECTNESS_CAP ?? 30);
