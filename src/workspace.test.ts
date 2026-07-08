import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { captureArtifacts } from "./capture.js";
import { prepareWorkspace, resolveWithin, slugify } from "./workspace.js";
import type { BundleVariant, Task, Variant } from "./types.js";

const base = "/tmp/base";

const tmpResultsDir = () => fs.mkdtemp(path.join(os.tmpdir(), "bench-run-"));

test("slugify makes model aliases filesystem-safe", () => {
  assert.equal(slugify("sonnet"), "sonnet");
  assert.equal(slugify("claude-opus-4-8"), "claude-opus-4-8");
  assert.equal(slugify("fable/5 preview"), "fable-5-preview");
});

test("prepareWorkspace cellIds carry the model slug (no timestamp) and are unique per model", async () => {
  const variant: Variant = { name: "v", type: "claude-md", content: "# CLAUDE\n" };
  const task: Task = {
    meta: { id: "tid", title: "t", logicBearing: true, securityRelevant: false },
    dir: "/nonexistent",
    prompt: "x",
  };
  const runResultsDir = await tmpResultsDir();
  try {
    const a = await prepareWorkspace(variant, task, "sonnet", runResultsDir);
    const b = await prepareWorkspace(variant, task, "opus", runResultsDir);
    assert.equal(a.cellId, "tid__v__sonnet"); // no timestamp — unique within a run
    assert.equal(b.cellId, "tid__v__opus");
    assert.notEqual(a.cellId, b.cellId);
    assert.equal(a.cellDir, path.join(runResultsDir, "tid__v__sonnet"));
  } finally {
    await fs.rm(runResultsDir, { recursive: true, force: true });
  }
});

test("resolveWithin returns the absolute path for a safe relative entry", () => {
  assert.equal(resolveWithin(base, "package.json"), path.join(base, "package.json"));
  assert.equal(resolveWithin(base, "src/index.ts"), path.join(base, "src/index.ts"));
});

test("resolveWithin rejects a parent-traversal entry", () => {
  assert.throws(() => resolveWithin(base, "../evil"), /escapes its base/);
  assert.throws(() => resolveWithin(base, "../../etc/passwd"), /escapes its base/);
  assert.throws(() => resolveWithin(base, "src/../../evil"), /escapes its base/);
});

test("resolveWithin rejects an absolute-path entry", () => {
  assert.throws(() => resolveWithin(base, "/etc/passwd"), /escapes its base/);
});

test("resolveWithin rejects the base dir itself (empty relative)", () => {
  assert.throws(() => resolveWithin(base, "."), /escapes its base/);
});

// Integration: exercises the real prepareWorkspace + captureArtifacts git path.
test("captured file list excludes dependency/build artifacts, keeps source & tests", async () => {
  const variant: Variant = { name: "excltest", type: "claude-md", content: "# CLAUDE\n" };
  const task: Task = {
    meta: { id: "excl", title: "t", logicBearing: true, securityRelevant: false },
    dir: "/nonexistent", // no seedFiles, so this is never read
    prompt: "x",
  };
  const runResultsDir = await tmpResultsDir();
  const ws = await prepareWorkspace(variant, task, "sonnet", runResultsDir);
  try {
    // cellId is nested under the run's results dir with no timestamp.
    assert.equal(ws.cellId, "excl__excltest__sonnet");
    assert.equal(ws.cellDir, path.join(runResultsDir, "excl__excltest__sonnet"));

    // Simulate the agent's own output PLUS a legitimate `npm install`.
    const write = async (rel: string, body: string) => {
      const full = path.join(ws.workspaceDir, rel);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, body);
    };
    await write("node_modules/left-pad/index.js", "module.exports = 1;\n");
    await write("dist/bundle.js", "1;\n");
    await write("coverage/lcov.info", "TN:\n");
    await write("debug.log", "noise\n");
    await write("src/app.ts", "export const x = 1;\n");
    await write("app.test.ts", "// test\n");

    const art = await captureArtifacts({
      cellId: ws.cellId,
      variant: "excltest",
      taskId: "excl",
      cellDir: ws.cellDir,
      workspaceDir: ws.workspaceDir,
      ndjson: "",
      executorModel: "sonnet",
      executorOk: true,
      executorTimedOut: false,
      executorMetrics: { wallMs: 1234 },
    });
    const paths = art.changedFiles.map((f) => f.path);

    // result.json lands under <runResultsDir>/<cellId>/ (nested, self-contained).
    await fs.writeFile(path.join(ws.cellDir, "result.json"), "{}");
    assert.ok(
      await fs
        .stat(path.join(runResultsDir, "excl__excltest__sonnet", "result.json"))
        .then(() => true),
    );

    assert.ok(paths.includes("src/app.ts"), "source file should be captured");
    assert.ok(paths.includes("app.test.ts"), "test file should be captured");
    assert.equal(art.testFilesPresent, true);
    assert.ok(!paths.some((p) => p.startsWith("node_modules/")), "node_modules excluded");
    assert.ok(!paths.includes("dist/bundle.js"), "dist excluded");
    assert.ok(!paths.includes("coverage/lcov.info"), "coverage excluded");
    assert.ok(!paths.includes("debug.log"), "*.log excluded");
    // CLAUDE.md is still excluded from the diff.
    assert.ok(!paths.includes("CLAUDE.md"), "variant CLAUDE.md excluded");
  } finally {
    await fs.rm(runResultsDir, { recursive: true, force: true });
  }
});

// Integration: a BUNDLE variant materializes CLAUDE.md + .claude/ at project
// scope, makes hooks executable, and excludes the ENTIRE bundle from the diff.
test("bundle prepareWorkspace materializes .claude/ + CLAUDE.md and excludes both from the diff", async () => {
  // Build a synthetic bundle on disk (CLAUDE.md + a skill + a hook script).
  const bundleSrc = await fs.mkdtemp(path.join(os.tmpdir(), "bench-bundle-"));
  await fs.writeFile(path.join(bundleSrc, "CLAUDE.md"), "# bundle memory\n");
  await fs.mkdir(path.join(bundleSrc, "claude", "skills", "foo"), { recursive: true });
  await fs.writeFile(path.join(bundleSrc, "claude", "skills", "foo", "SKILL.md"), "# foo\n");
  await fs.mkdir(path.join(bundleSrc, "claude", "hooks"), { recursive: true });
  await fs.writeFile(path.join(bundleSrc, "claude", "hooks", "h.sh"), "#!/usr/bin/env bash\n");

  const variant: BundleVariant = {
    name: "bnd",
    type: "bundle",
    install: "copy",
    claudeMdPath: path.join(bundleSrc, "CLAUDE.md"),
    configDirPath: path.join(bundleSrc, "claude"),
  };
  const task: Task = {
    meta: { id: "tid", title: "t", logicBearing: true, securityRelevant: false },
    dir: "/nonexistent",
    prompt: "x",
  };
  const runResultsDir = await tmpResultsDir();
  const ws = await prepareWorkspace(variant, task, "sonnet", runResultsDir);
  try {
    // Bundle is materialized at project scope.
    assert.equal(
      await fs.readFile(path.join(ws.workspaceDir, "CLAUDE.md"), "utf8"),
      "# bundle memory\n",
    );
    assert.ok(
      await fs
        .stat(path.join(ws.workspaceDir, ".claude", "skills", "foo", "SKILL.md"))
        .then(() => true),
    );
    // Shipped hook script is executable.
    const hookMode = (await fs.stat(path.join(ws.workspaceDir, ".claude", "hooks", "h.sh"))).mode;
    assert.ok((hookMode & 0o111) !== 0, "hook .sh should be executable");

    // The "agent" writes a genuine source file.
    await fs.writeFile(path.join(ws.workspaceDir, "app.ts"), "export const x = 1;\n");

    const art = await captureArtifacts({
      cellId: ws.cellId,
      variant: "bnd",
      taskId: "tid",
      cellDir: ws.cellDir,
      workspaceDir: ws.workspaceDir,
      ndjson: "",
      executorModel: "sonnet",
      executorOk: true,
      executorTimedOut: false,
      executorMetrics: { wallMs: 1 },
    });
    const paths = art.changedFiles.map((f) => f.path);

    // The agent's real file is captured...
    assert.ok(paths.includes("app.ts"), "genuine source file should be captured");
    // ...but NONE of the bundle is (CLAUDE.md + the whole .claude/ tree excluded).
    assert.ok(!paths.includes("CLAUDE.md"), "bundle CLAUDE.md excluded");
    assert.ok(!paths.some((p) => p.startsWith(".claude/")), "entire .claude/ tree excluded");
    assert.doesNotMatch(art.diff, /skills\/foo\/SKILL\.md/, "skills must not appear in the diff");
  } finally {
    await fs.rm(runResultsDir, { recursive: true, force: true });
    await fs.rm(bundleSrc, { recursive: true, force: true });
  }
});
