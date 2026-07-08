import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyChangedFiles,
  classifyFile,
  collectSecrets,
  extractTranscript,
  hasTestFiles,
  redactSecrets,
} from "./capture.js";
import { OAUTH_TOKEN_ENV } from "./config.js";

test("classifyFile: test files by suffix and __tests__ dir", () => {
  assert.equal(classifyFile("src/redirect.test.ts"), "test");
  assert.equal(classifyFile("src/redirect.spec.js"), "test");
  assert.equal(classifyFile("test/__tests__/foo.ts"), "test");
  assert.equal(classifyFile("redirect.test.tsx"), "test");
});

test("classifyFile: test config files count as test even with .ts extension", () => {
  assert.equal(classifyFile("vitest.config.ts"), "test");
  assert.equal(classifyFile("jest.config.js"), "test");
  assert.equal(classifyFile("packages/app/vitest.config.mts"), "test");
});

test("classifyFile: docs by .md and docs/ dir", () => {
  assert.equal(classifyFile("README.md"), "docs");
  assert.equal(classifyFile("SECURITY.md"), "docs");
  assert.equal(classifyFile("docs/architecture.txt"), "docs");
});

test("classifyFile: everything else is source", () => {
  assert.equal(classifyFile("src/redirect.ts"), "source");
  assert.equal(classifyFile("src/handler.js"), "source");
  assert.equal(classifyFile("package.json"), "source");
});

test("classifyChangedFiles trims, drops blanks, classifies", () => {
  const files = classifyChangedFiles(["src/a.ts", "  ", "b.test.ts", "README.md"]);
  assert.deepEqual(files, [
    { path: "src/a.ts", kind: "source" },
    { path: "b.test.ts", kind: "test" },
    { path: "README.md", kind: "docs" },
  ]);
});

test("hasTestFiles reflects presence of a test-classified file", () => {
  assert.equal(hasTestFiles([{ path: "src/a.ts", kind: "source" }]), false);
  assert.equal(
    hasTestFiles([
      { path: "src/a.ts", kind: "source" },
      { path: "a.test.ts", kind: "test" },
    ]),
    true,
  );
});

test("redactSecrets replaces exact secret occurrences, longest-first", () => {
  const token = "sk-ant-oat01-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const text = `diff line with ${token} embedded and again ${token}`;
  const out = redactSecrets(text, [token]);
  assert.doesNotMatch(out, /sk-ant/);
  assert.equal(out.match(/\[REDACTED-CREDENTIAL\]/g)?.length, 2);
});

test("redactSecrets handles overlapping secrets without leaving fragments", () => {
  const long = "SUPERSECRETVALUE123456";
  const short = "SECRET";
  const out = redactSecrets(`x ${long} y`, [short, long]);
  assert.doesNotMatch(out, /SUPERSECRET/);
  assert.match(out, /x \[REDACTED-CREDENTIAL\] y/);
});

test("redactSecrets is a no-op when there are no secrets", () => {
  assert.equal(redactSecrets("nothing to hide", []), "nothing to hide");
});

test("collectSecrets returns the resolved token; redaction scrubs it from a diff", () => {
  const token = "sk-ant-oat01-TESTTOKENVALUE1234567890";
  const prev = process.env[OAUTH_TOKEN_ENV];
  process.env[OAUTH_TOKEN_ENV] = token; // env source wins over any token file
  try {
    const secrets = collectSecrets();
    assert.deepEqual(secrets, [token]);
    const diff = `+ const auth = '${token}';`;
    const redacted = redactSecrets(diff, secrets);
    assert.doesNotMatch(redacted, /sk-ant/);
    assert.match(redacted, /\[REDACTED-CREDENTIAL\]/);
  } finally {
    if (prev === undefined) delete process.env[OAUTH_TOKEN_ENV];
    else process.env[OAUTH_TOKEN_ENV] = prev;
  }
});

test("extractTranscript pulls assistant text and tool names, skips bad lines", () => {
  const ndjson = [
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Hello" }] } }),
    "not json",
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Write" }] } }),
    JSON.stringify({ type: "result", subtype: "success" }),
  ].join("\n");
  const t = extractTranscript(ndjson);
  assert.match(t, /Hello/);
  assert.match(t, /\[tool: Write\]/);
});
