import fs from "node:fs/promises";
import path from "node:path";
import { resolveOAuthToken } from "./auth.js";
import type { CallMetrics, ChangedFile, FileKind, RunArtifacts } from "./types.js";
import { git } from "./workspace.js";

// --- Pure helpers (unit-tested) ---------------------------------------------

const TEST_CONFIG_RE = /(^|\/)(vitest|jest|mocha|ava)\.config\.[cm]?[jt]s$/i;
const TEST_FILE_RE = /(\.(test|spec)\.[cm]?[jt]sx?$)|(^|\/)__tests__\//i;
const DOCS_RE = /(\.md$)|(^|\/)docs\//i;

/**
 * Classify a changed file path into test / docs / source. Precedence is
 * test > docs > source: a `vitest.config.ts` is a test artifact even though it
 * ends in .ts, and a markdown file under docs/ is documentation.
 */
export function classifyFile(filePath: string): FileKind {
  const p = filePath.replace(/\\/g, "/");
  if (TEST_FILE_RE.test(p) || TEST_CONFIG_RE.test(p)) return "test";
  if (DOCS_RE.test(p)) return "docs";
  return "source";
}

/** Parse `git diff --name-only`-style output into classified ChangedFile[]. */
export function classifyChangedFiles(paths: string[]): ChangedFile[] {
  return paths
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => ({ path: p, kind: classifyFile(p) }));
}

/** True if any changed file is a test file/config. */
export function hasTestFiles(files: ChangedFile[]): boolean {
  return files.some((f) => f.kind === "test");
}

/**
 * Replace every exact occurrence of any secret string with a redaction marker.
 * Longest-first so overlapping secrets do not leave partial fragments. Pure and
 * unit-testable; the caller supplies the secrets (never logged or persisted).
 */
export function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret.length === 0) continue;
    out = out.split(secret).join("[REDACTED-CREDENTIAL]");
  }
  return out;
}

/**
 * The secret material to scrub from captured artifacts. Under the token model
 * that is exactly the resolved OAuth token: the executor's agent can read
 * CLAUDE_CODE_OAUTH_TOKEN from its own env and write it into /work, which capture
 * would otherwise persist to results/. Returns [] if no token resolves (should
 * not happen post-preflight) so redaction is a silent no-op.
 */
export function collectSecrets(): string[] {
  try {
    const token = resolveOAuthToken();
    return token.length > 0 ? [token] : [];
  } catch {
    return [];
  }
}

interface TraceEvent {
  type?: string;
  subtype?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
}

/**
 * Extract a readable transcript from the NDJSON stream: assistant text blocks
 * and the names of tools the agent used. Malformed lines are skipped.
 */
export function extractTranscript(ndjson: string): string {
  const lines = ndjson.split("\n").filter((l) => l.trim().length > 0);
  const out: string[] = [];

  for (const line of lines) {
    let evt: TraceEvent;
    try {
      evt = JSON.parse(line) as TraceEvent;
    } catch {
      continue;
    }
    const content = evt.message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (typeof block !== "object" || block === null) continue;
      const b = block as { type?: string; text?: string; name?: string };
      if (b.type === "text" && typeof b.text === "string") {
        out.push(b.text.trim());
      } else if (b.type === "tool_use" && typeof b.name === "string") {
        out.push(`[tool: ${b.name}]`);
      }
    }
  }
  return out.filter((s) => s.length > 0).join("\n\n");
}

// --- I/O capture step -------------------------------------------------------

/**
 * After the executor container exits, stage all changes in the workspace,
 * produce the diff, classify files, and derive signals. Writes diff.patch and
 * transcript.txt into the run dir.
 */
export async function captureArtifacts(args: {
  cellId: string;
  variant: string;
  taskId: string;
  cellDir: string;
  workspaceDir: string;
  ndjson: string;
  executorModel: string;
  executorOk: boolean;
  executorTimedOut: boolean;
  executorMetrics: CallMetrics;
  failureReason?: string;
}): Promise<RunArtifacts> {
  await git(args.workspaceDir, ["add", "-A"]);
  const rawDiff = await git(args.workspaceDir, ["diff", "--cached"]);
  const nameOnly = await git(args.workspaceDir, ["diff", "--cached", "--name-only"]);
  const changedFiles = classifyChangedFiles(nameOnly.split("\n"));

  const rawTranscript = extractTranscript(args.ndjson);

  // Defense in depth: the executor's agent receives the subscription token via
  // its own env, so a hostile task could copy it into /work. Redact the token
  // before it ever touches the host results/ dir or the judge prompt.
  const secrets = collectSecrets();
  const diff = redactSecrets(rawDiff, secrets);
  const transcript = redactSecrets(rawTranscript, secrets);

  await fs.writeFile(path.join(args.cellDir, "diff.patch"), diff);
  await fs.writeFile(path.join(args.cellDir, "transcript.txt"), transcript);

  const artifacts: RunArtifacts = {
    cellId: args.cellId,
    variant: args.variant,
    taskId: args.taskId,
    workspaceDir: args.workspaceDir,
    diff,
    changedFiles,
    transcript,
    testFilesPresent: hasTestFiles(changedFiles),
    executorModel: args.executorModel,
    executorMetrics: args.executorMetrics,
    executorOk: args.executorOk,
    executorTimedOut: args.executorTimedOut,
    ...(args.failureReason ? { failureReason: args.failureReason } : {}),
  };
  return artifacts;
}
