import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_CONCURRENCY,
  formatVariantListLine,
  loadVariants,
  parseConcurrency,
  parseDelayMs,
  parseModels,
} from "./cli.js";
import type { CopyBundleVariant, SetupBundleVariant } from "./types.js";

test("parseModels splits comma/space, trims, dedups, drops empties", () => {
  // Simulates `--models "fable, sonnet ,opus"` (one token).
  assert.deepEqual(parseModels(["fable, sonnet ,opus"], "sonnet"), [
    "fable",
    "sonnet",
    "opus",
  ]);
});

test("parseModels merges multiple --models flags and dedups across them", () => {
  assert.deepEqual(parseModels(["fable,sonnet", "opus", "fable"], "sonnet"), [
    "fable",
    "sonnet",
    "opus",
  ]);
});

test("parseModels falls back to the default when nothing valid is given", () => {
  assert.deepEqual(parseModels([], "sonnet"), ["sonnet"]);
  assert.deepEqual(parseModels(["", "  ", ","], "opus"), ["opus"]);
});

test("parseConcurrency: valid integers pass through", () => {
  assert.equal(parseConcurrency("1"), 1);
  assert.equal(parseConcurrency("3"), 3);
  assert.equal(parseConcurrency(" 5 "), 5);
});

test("parseConcurrency: missing → default 1", () => {
  assert.equal(parseConcurrency(undefined), 1);
});

test("parseConcurrency: zero, negative, and non-numeric throw", () => {
  assert.throws(() => parseConcurrency("0"), />= 1/);
  assert.throws(() => parseConcurrency("-2"), /positive integer|>= 1/);
  assert.throws(() => parseConcurrency("abc"), /positive integer/);
  assert.throws(() => parseConcurrency("2.5"), /positive integer/);
});

test("parseConcurrency: absurd values clamp to the max with a warning", () => {
  const warnings: string[] = [];
  const n = parseConcurrency("1000", (m) => warnings.push(m));
  assert.equal(n, MAX_CONCURRENCY);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /clamping/);
});

test("parseDelayMs: missing → 0 (no pacing)", () => {
  assert.equal(parseDelayMs(undefined), 0);
});

test("parseDelayMs: valid non-negative integers pass through", () => {
  assert.equal(parseDelayMs("0"), 0);
  assert.equal(parseDelayMs("500"), 500);
  assert.equal(parseDelayMs(" 1500 "), 1500);
});

test("parseDelayMs: negative and non-numeric throw", () => {
  assert.throws(() => parseDelayMs("-1"), />= 0|non-negative/);
  assert.throws(() => parseDelayMs("abc"), /non-negative integer/);
  assert.throws(() => parseDelayMs("2.5"), /non-negative integer/);
});

// --- Variant loading (reads the real prompts/ corpus) -----------------------

test("loadVariants: naked variant loads with empty content as claude-md", async () => {
  const variants = await loadVariants();
  const naked = variants.find((v) => v.name === "naked");
  assert.ok(naked, "naked variant should be discovered");
  assert.equal(naked.type, "claude-md");
  assert.equal(naked.type === "claude-md" ? naked.content : "MISSING", "");
});

test("loadVariants: agentic-os loads as a copy bundle with resolved config paths", async () => {
  const variants = await loadVariants();
  const bundle = variants.find((v) => v.name === "agentic-os");
  assert.ok(bundle, "agentic-os variant should be discovered");
  assert.equal(bundle.type, "bundle");
  assert.ok(bundle.type === "bundle" && bundle.install === "copy");
  const b = bundle as CopyBundleVariant;
  assert.match(b.claudeMdPath, /prompts\/agentic-os\/CLAUDE\.md$/);
  assert.match(b.configDirPath, /prompts\/agentic-os\/claude$/);
  assert.match(b.description ?? "", /agentic-os v2\.6\.0/);
});

test("loadVariants: gstack loads as a setup bundle with a setupCommand", async () => {
  const variants = await loadVariants();
  const bundle = variants.find((v) => v.name === "gstack");
  assert.ok(bundle, "gstack variant should be discovered");
  assert.ok(bundle.type === "bundle" && bundle.install === "setup");
  const b = bundle as SetupBundleVariant;
  assert.match(b.claudeMdPath, /prompts\/gstack\/CLAUDE\.md$/);
  assert.match(b.setupCommand, /\/opt\/gstack\/setup --local/);
  assert.match(b.description ?? "", /gstack 1\.58\.5\.0/);
});

test("formatVariantListLine: shows the type (and description for bundles)", () => {
  assert.equal(
    formatVariantListLine({ name: "naked", type: "claude-md", content: "" }),
    "  - naked [claude-md]",
  );
  assert.equal(
    formatVariantListLine({
      name: "agentic-os",
      type: "bundle",
      install: "copy",
      claudeMdPath: "/x/CLAUDE.md",
      configDirPath: "/x/claude",
      description: "agentic-os v2.6.0",
    }),
    "  - agentic-os [bundle] — agentic-os v2.6.0",
  );
});
