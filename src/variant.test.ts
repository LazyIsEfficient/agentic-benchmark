import assert from "node:assert/strict";
import { test } from "node:test";
import { parseVariantManifest } from "./variant.js";

test("parseVariantManifest: empty object → claude-md defaults (install copy)", () => {
  assert.deepEqual(parseVariantManifest({}), {
    type: "claude-md",
    claudeMd: "CLAUDE.md",
    configDir: "claude",
    install: "copy",
  });
});

test("parseVariantManifest: full copy-bundle manifest passes through", () => {
  assert.deepEqual(
    parseVariantManifest({
      type: "bundle",
      claudeMd: "CLAUDE.md",
      configDir: "claude",
      description: "agentic-os v3.0.1",
    }),
    {
      type: "bundle",
      claudeMd: "CLAUDE.md",
      configDir: "claude",
      install: "copy",
      description: "agentic-os v3.0.1",
    },
  );
});

test("parseVariantManifest: install defaults to copy", () => {
  assert.equal(parseVariantManifest({ type: "bundle" }).install, "copy");
});

test("parseVariantManifest: install:setup requires a setupCommand", () => {
  assert.throws(
    () => parseVariantManifest({ type: "bundle", install: "setup" }),
    /requires a "setupCommand"/,
  );
  const m = parseVariantManifest({
    type: "bundle",
    install: "setup",
    setupCommand: "/opt/gstack/setup --local",
  });
  assert.equal(m.install, "setup");
  assert.equal(m.setupCommand, "/opt/gstack/setup --local");
});

test("parseVariantManifest: rejects unknown install mode and blank setupCommand", () => {
  assert.throws(() => parseVariantManifest({ install: "symlink" }), /install/);
  assert.throws(
    () => parseVariantManifest({ type: "bundle", install: "setup", setupCommand: "  " }),
    /setupCommand/,
  );
});

test("parseVariantManifest: bundle with defaulted paths", () => {
  const m = parseVariantManifest({ type: "bundle" });
  assert.equal(m.type, "bundle");
  assert.equal(m.claudeMd, "CLAUDE.md");
  assert.equal(m.configDir, "claude");
});

test("parseVariantManifest: rejects an unknown type", () => {
  assert.throws(() => parseVariantManifest({ type: "plugin" }), /must be one of/);
});

test("parseVariantManifest: rejects non-object input", () => {
  assert.throws(() => parseVariantManifest("nope"), /must be a JSON object/);
  assert.throws(() => parseVariantManifest(null), /must be a JSON object/);
});

test("parseVariantManifest: rejects empty/blank string fields", () => {
  assert.throws(() => parseVariantManifest({ claudeMd: "" }), /claudeMd/);
  assert.throws(() => parseVariantManifest({ configDir: "   " }), /configDir/);
});

test("parseVariantManifest: rejects a non-string description", () => {
  assert.throws(() => parseVariantManifest({ description: 42 }), /description/);
});
