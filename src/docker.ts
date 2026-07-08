import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolveOAuthToken } from "./auth.js";
import {
  CONTAINER_CONFIG_DIR,
  CONTAINER_KILL_GRACE_MS,
  CONTAINER_WORK_DIR,
  EXECUTOR_TIMEOUT_MS,
  IMAGE_NAME,
  JUDGE_TIMEOUT_MS,
  OAUTH_TOKEN_ENV,
  REPO_ROOT,
  SETUP_TIMEOUT_MS,
} from "./config.js";

/** The subset of `spawn` we depend on; injectable so the timeout/grace logic is
 * testable without invoking real docker. */
export type SpawnFn = typeof spawn;

export interface ContainerResult {
  stdout: string;
  stderr: string;
  /** Process exit code, or null if killed by signal/timeout. */
  exitCode: number | null;
  /** True when the run hit the wall-clock timeout and was force-killed. */
  timedOut: boolean;
  /**
   * Host-measured wall-clock ms around the whole `docker run` (spawn → close).
   * The truest "actual time spent" — includes container startup, npm install,
   * etc. — vs the agent-session `duration_ms` the CLI reports.
   */
  wallMs: number;
}

interface RunOpts {
  /** Extra `docker run` args placed BEFORE the image name (mounts, env, etc). */
  dockerArgs: string[];
  /** Command + args run INSIDE the container, after the image name. */
  command: string[];
  timeoutMs: number;
  /**
   * The prompt, written to the container's stdin and then closed. Sending the
   * prompt over stdin (rather than as a `-p "<huge>"` argv element) keeps prompt
   * size irrelevant to the OS ARG_MAX limit — otherwise a large judge evidence
   * bundle fails the spawn with E2BIG.
   */
  stdin?: string;
  /** Optional callback for each chunk of stdout (used to tee the NDJSON trace). */
  onStdout?: (chunk: string) => void;
  /** Grace window before force-resolving a hung run. Defaults to config. */
  graceMs?: number;
  /** Injectable spawn (tests only); defaults to node:child_process spawn. */
  spawnFn?: SpawnFn;
}

/**
 * Low-level `docker run` wrapper. Assigns a unique container name so a timeout
 * can force-kill the exact container. Uses --rm for automatic cleanup and -i so
 * the container keeps stdin open to receive the prompt.
 *
 * Timeout enforcement is authoritative and time-bounded: when the timer fires we
 * `docker kill <name>` AND SIGKILL the local `docker run` client; if the client
 * still hasn't emitted `close` within the grace window we force-resolve the
 * promise once as timed-out (exitCode null) and stop listening. This caps total
 * wall-clock at ≈ timeoutMs + graceMs no matter how docker behaves — a real run
 * once lingered ~14 min past the kill. A `settled` flag prevents double-resolve.
 * The happy path is unchanged: fast runs resolve on `close`.
 */
export async function runContainer(opts: RunOpts): Promise<ContainerResult> {
  const spawnFn = opts.spawnFn ?? spawn;
  const graceMs = opts.graceMs ?? CONTAINER_KILL_GRACE_MS;
  const containerName = `claude-bench-${randomUUID()}`;
  const args = [
    "run",
    "--rm",
    "-i",
    "--name",
    containerName,
    ...opts.dockerArgs,
    IMAGE_NAME,
    ...opts.command,
  ];

  const t0 = Date.now();
  return await new Promise<ContainerResult>((resolve, reject) => {
    const child = spawnFn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;

    const clearTimers = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (graceTimer) clearTimeout(graceTimer);
    };
    /** Resolve/reject exactly once; later events are ignored. */
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimers();
      fn();
    };
    const sigkill = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    };

    // Feed the prompt over stdin, then close it. A write/EPIPE error (e.g. the
    // container exited before reading) is swallowed here; the real outcome is
    // reported via exitCode/stderr on 'close'.
    child.stdin?.on("error", () => {});
    if (opts.stdin !== undefined) child.stdin?.write(opts.stdin);
    child.stdin?.end();

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      // Authoritative kill: stop the container by name AND the local run client.
      const killer = spawnFn("docker", ["kill", containerName], { stdio: "ignore" });
      killer.on("error", () => {});
      sigkill();
      // Backstop: if the client won't die/close, force-resolve after the grace.
      graceTimer = setTimeout(() => {
        sigkill();
        settle(() =>
          resolve({ stdout, stderr, exitCode: null, timedOut: true, wallMs: Date.now() - t0 }),
        );
      }, graceMs);
    }, opts.timeoutMs);

    child.stdout?.on("data", (d: Buffer) => {
      const s = d.toString();
      stdout += s;
      opts.onStdout?.(s);
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    child.on("error", (err) => {
      settle(() => reject(err));
    });

    child.on("close", (code) => {
      settle(() =>
        resolve({ stdout, stderr, exitCode: code, timedOut, wallMs: Date.now() - t0 }),
      );
    });
  });
}

/** Build the benchmark image. Streams build output to the parent's stdout. */
export async function buildImage(): Promise<ContainerResult> {
  const t0 = Date.now();
  return await new Promise<ContainerResult>((resolve, reject) => {
    const child = spawn("docker", ["build", "-t", IMAGE_NAME, REPO_ROOT], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
      process.stdout.write(d);
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      process.stderr.write(d);
    });
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({ stdout, stderr, exitCode: code, timedOut: false, wallMs: Date.now() - t0 }),
    );
  });
}

/**
 * Base `docker run` args shared by every invocation. The ONLY auth surface is
 * the OAuth token env var — no host credential file is mounted into any
 * container. The container uses its image-provided writable /cfg (ephemeral,
 * discarded by --rm). An optional workspace dir is bind-mounted so the host can
 * read the resulting diff after the container exits.
 */
function baseArgs(workspaceDir?: string): string[] {
  const args = [
    "-e",
    `CLAUDE_CONFIG_DIR=${CONTAINER_CONFIG_DIR}`,
    "-e",
    `${OAUTH_TOKEN_ENV}=${resolveOAuthToken()}`,
  ];
  if (workspaceDir) {
    args.push("-v", `${workspaceDir}:${CONTAINER_WORK_DIR}`, "-w", CONTAINER_WORK_DIR);
  }
  return args;
}

/**
 * Run a bundle's setup pre-step: execute `setupCommand` with cwd=/work (the
 * bind-mounted workspace) so it can register skills into `<workspace>/.claude`
 * before the executor runs. No prompt/stdin; its own timeout. The command runs
 * via `bash -lc` so PATH (Bun, /opt/gstack/bin) and shell features resolve.
 */
export async function runSetup(args: {
  workspaceDir: string;
  setupCommand: string;
}): Promise<ContainerResult> {
  return await runContainer({
    dockerArgs: baseArgs(args.workspaceDir),
    command: ["bash", "-lc", args.setupCommand],
    timeoutMs: SETUP_TIMEOUT_MS,
  });
}

/**
 * Run the executor: a full agent invocation with tools enabled, streaming
 * NDJSON. The workspace is bind-mounted so the host can read the resulting
 * diff after the container exits.
 */
export async function runExecutor(args: {
  workspaceDir: string;
  taskPrompt: string;
  model: string;
  onStdout?: (chunk: string) => void;
}): Promise<ContainerResult> {
  return await runContainer({
    dockerArgs: baseArgs(args.workspaceDir),
    // Prompt goes over stdin (see RunOpts.stdin) so a large future task can't
    // reintroduce E2BIG.
    command: [
      "claude",
      "-p",
      "--model",
      args.model,
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
      "--no-session-persistence",
    ],
    stdin: args.taskPrompt,
    timeoutMs: EXECUTOR_TIMEOUT_MS,
    ...(args.onStdout ? { onStdout: args.onStdout } : {}),
  });
}

/**
 * Run the judge: tool-less, structured-output scoring. No workspace mount — all
 * evidence is embedded in the prompt. `--tools ""` guarantees the judge cannot
 * read files or run commands, only reason over the provided evidence.
 */
export async function runJudge(args: {
  judgePrompt: string;
  model: string;
}): Promise<ContainerResult> {
  return await runContainer({
    dockerArgs: baseArgs(),
    // No --json-schema: CLI-side schema enforcement made Opus exhaust its
    // structured-output retries and fail. The prompt specifies the JSON shape
    // instead, and the harness parses + validates it. Evidence goes over stdin
    // (it can be large, which otherwise triggers spawn E2BIG).
    command: [
      "claude",
      "-p",
      "--model",
      args.model,
      "--output-format",
      "json",
      "--tools",
      "",
    ],
    stdin: args.judgePrompt,
    timeoutMs: JUDGE_TIMEOUT_MS,
  });
}

/**
 * Preflight auth probe. Runs a trivial tool-less prompt; returns whether the
 * container is logged in. Never mutates state.
 */
export async function checkAuth(model: string): Promise<{
  loggedIn: boolean;
  detail: string;
}> {
  const res = await runContainer({
    dockerArgs: baseArgs(),
    // Prompt over stdin for consistency with the real runs.
    command: [
      "claude",
      "-p",
      "--model",
      model,
      "--output-format",
      "json",
      "--tools",
      "",
    ],
    stdin: "ping",
    timeoutMs: 120_000,
  });

  const notLoggedIn =
    /not logged in/i.test(res.stdout) || /not logged in/i.test(res.stderr);
  return {
    loggedIn: !notLoggedIn && res.exitCode === 0,
    detail: (res.stdout || res.stderr || "").slice(0, 500),
  };
}
