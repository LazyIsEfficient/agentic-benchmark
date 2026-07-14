import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  VARIANT_FILENAME,
  WORKSPACE_CONFIG_DIR,
  WORKSPACE_EXCLUDE_PATTERNS,
} from "./config.js";
import type { Task, Variant } from "./types.js";

const execFileAsync = promisify(execFile);

/** Buffer ceiling for git stdout (256 MiB) so a large `git diff` never throws. */
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

/** Run a git command inside a workspace, returning stdout. */
export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: GIT_MAX_BUFFER,
  });
  return stdout;
}

/**
 * Resolve a declared relative path against a base dir and reject anything that
 * escapes it (path traversal via `../`, absolute paths, or symlink-style
 * tricks). Seed file paths come from task meta.json, which is repo-controlled,
 * but validating them keeps a malformed/hostile task from reading or writing
 * outside its sandbox. Returns the safe absolute path.
 */
export function resolveWithin(baseDir: string, relPath: string): string {
  const base = path.resolve(baseDir);
  const resolved = path.resolve(base, relPath);
  const rel = path.relative(base, resolved);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(
      `Path "${relPath}" escapes its base directory (${baseDir}); refusing.`,
    );
  }
  return resolved;
}

export interface PreparedWorkspace {
  /** Per-(variant×task×model[×repeat]) id, unique within a run (no timestamp needed). */
  cellId: string;
  /** <runResultsDir>/<cellId> — holds this cell's artifacts + workspace. */
  cellDir: string;
  /** <cellDir>/workspace — the dir bind-mounted to /work. */
  workspaceDir: string;
}

/** Filesystem-safe slug: non-alphanumerics → single dashes. */
export function slugify(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Build the cellId for one (task × variant × model) cell, optionally tagged
 * with a repeat index for cross-run reliability sweeps.
 *
 * Calling convention for `repeat` (enforced by the cli, not here): pass it
 * ONLY when the run's REPEATS > 1, and then for ALL repeats including the
 * first (r1..rN) — never mix tagged and untagged ids within one run, so
 * grouping stays uniform. When `repeat` is undefined the output is
 * byte-for-byte identical to the single-run format
 * (`task__variant__modelSlug`), keeping default-run cellIds, dir names, and
 * report keys unchanged.
 *
 * @throws {RangeError} when `repeat` is provided but not a positive integer —
 *   a fractional or zero repeat is a harness bug, so fail loud.
 */
export function buildCellId(
  taskId: string,
  variantName: string,
  executorModel: string,
  repeat?: number,
): string {
  if (repeat !== undefined && (!Number.isInteger(repeat) || repeat < 1)) {
    throw new RangeError(
      `repeat must be a positive integer when provided; got ${repeat}`,
    );
  }
  const cellId = `${taskId}__${variantName}__${slugify(executorModel)}`;
  return repeat === undefined ? cellId : `${cellId}__r${repeat}`;
}

/**
 * Prepare an isolated workspace for one (variant × task × model) cell under the
 * run's results dir. The cellId is unique within a run, so no timestamp is
 * needed. Seed files are committed as the git baseline, then the variant's
 * CLAUDE.md is written and registered in .git/info/exclude — untracked AND
 * ignored, so it never appears in the diff yet is present for claude to read as
 * its system prompt.
 *
 * `repeat` follows the buildCellId calling convention: omit it for single-run
 * benchmarks (output unchanged), pass r1..rN uniformly when REPEATS > 1 so two
 * repeats of the same cell get distinct cellIds and directories.
 */
export async function prepareWorkspace(
  variant: Variant,
  task: Task,
  executorModel: string,
  runResultsDir: string,
  repeat?: number,
): Promise<PreparedWorkspace> {
  const cellId = buildCellId(task.meta.id, variant.name, executorModel, repeat);
  const cellDir = path.join(runResultsDir, cellId);
  const workspaceDir = path.join(cellDir, "workspace");
  await fs.mkdir(workspaceDir, { recursive: true });

  // Copy seed files (if any) from tasks/<id>/ into the workspace. Both the read
  // source and the write destination are validated to stay inside their dirs.
  // Seed files may be authored under a `seed/` prefix (e.g. `seed/src/cart.ts`)
  // so the fixture's baseline sits in its own subdir; that prefix is a source-tree
  // convention only and must be stripped from the DESTINATION so the file lands at
  // the workspace root (`src/cart.ts`) where the agent works. Only a LEADING
  // `seed/` is stripped — tasks whose paths have no such prefix are unchanged.
  for (const rel of task.meta.seedFiles ?? []) {
    const src = resolveWithin(task.dir, rel);
    const destRel = rel.startsWith("seed/") ? rel.slice("seed/".length) : rel;
    const dest = resolveWithin(workspaceDir, destRel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(src, dest);
  }

  // git baseline. Use per-repo identity so this works on hosts with no global
  // git config.
  await git(workspaceDir, ["init", "-q"]);
  await git(workspaceDir, ["config", "user.email", "bench@localhost"]);
  await git(workspaceDir, ["config", "user.name", "bench"]);
  await git(workspaceDir, ["add", "-A"]);
  // --allow-empty so a task with no seed files still gets a baseline commit.
  await git(workspaceDir, ["commit", "-q", "--allow-empty", "-m", "baseline"]);

  // Register exclusions in .git/info/exclude (applied to the whole run, before
  // the agent runs): the variant config, plus dependency/build artifacts so a
  // legitimate `npm install` etc. is never captured as the agent's work. This
  // mechanism is invisible to the agent and survives it writing its own
  // .gitignore. For BUNDLES we exclude the ENTIRE `.claude/` tree too — the
  // shipped skills/agents/hooks must never be scored as the agent's own work.
  const excludeEntries = [VARIANT_FILENAME, ...WORKSPACE_EXCLUDE_PATTERNS];
  if (variant.type === "bundle") excludeEntries.push(`${WORKSPACE_CONFIG_DIR}/`);
  const excludePath = path.join(workspaceDir, ".git", "info", "exclude");
  await fs.appendFile(excludePath, `\n${excludeEntries.join("\n")}\n`);

  // Materialize the variant AFTER the baseline so it is present for Claude to
  // read but (being excluded) never part of the diff.
  await materializeVariant(variant, workspaceDir);

  return { cellId, cellDir, workspaceDir };
}

/**
 * Stage and commit one sequential step's tracked work, then return the new HEAD
 * SHA. `.claude/` (accumulating memory, and any bundle config) is excluded via
 * .git/info/exclude, so memory is NEVER committed and persists on the bind mount
 * between steps — that survival is the whole point of sequential-memory mode.
 * --allow-empty so a no-op step still advances HEAD, giving the next step a real
 * per-step baseline to diff against in isolation. Never re-run prepareWorkspace
 * between steps: re-materializing the workspace would wipe the accumulated memory.
 */
export async function commitStep(workspaceDir: string, message: string): Promise<string> {
  await git(workspaceDir, ["add", "-A"]);
  await git(workspaceDir, ["commit", "-q", "--allow-empty", "-m", message]);
  return (await git(workspaceDir, ["rev-parse", "HEAD"])).trim();
}

/**
 * Write the variant's config into the workspace at PROJECT scope.
 * - claude-md: drop a lone CLAUDE.md.
 * - copy bundle: CLAUDE.md + copy the vendored `.claude/` tree, chmod +x scripts.
 * - setup bundle: inject only CLAUDE.md; `.claude/` is populated later by the
 *   setup pre-step container (source is baked in the image, not vendored).
 */
async function materializeVariant(variant: Variant, workspaceDir: string): Promise<void> {
  if (variant.type === "claude-md") {
    await fs.writeFile(path.join(workspaceDir, VARIANT_FILENAME), variant.content);
    return;
  }

  // Both bundle kinds inject the CLAUDE.md doctrine.
  await fs.copyFile(variant.claudeMdPath, path.join(workspaceDir, VARIANT_FILENAME));

  if (variant.install === "copy") {
    const destConfig = path.join(workspaceDir, WORKSPACE_CONFIG_DIR);
    await fs.cp(variant.configDirPath, destConfig, { recursive: true });
    await makeScriptsExecutable(destConfig);
  }
  // setup bundles: `.claude/` is created by the setup pre-step at run time.
}

/** chmod +x every `*.sh` under `dir` (hooks and skill scripts need to run). */
async function makeScriptsExecutable(dir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir, { recursive: true });
  } catch {
    return;
  }
  for (const rel of entries) {
    if (!rel.endsWith(".sh")) continue;
    const full = path.join(dir, rel);
    await fs.chmod(full, 0o755).catch(() => {});
  }
}
