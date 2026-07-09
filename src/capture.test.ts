import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyChangedFiles,
  classifyFile,
  collectSecrets,
  extractTranscript,
  hasTestFiles,
  parseBehavior,
  redactSecrets,
} from "./capture.js";
import { OAUTH_TOKEN_ENV } from "./config.js";
import type { ChangedFile } from "./types.js";

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

// --- parseBehavior ----------------------------------------------------------

test("parseBehavior counts sub-agents (by type), tool calls, and redacts descriptions", () => {
  const token = "sk-ant-oat01-LEAKEDTOKEN1234567890";
  const ndjson = [
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "planning" },
          { type: "tool_use", name: "Bash", input: { command: "ls" } },
          {
            type: "tool_use",
            name: "Agent",
            input: { subagent_type: "engineer", description: `build it with ${token}` },
          },
        ],
      },
    }),
    "corrupt line {",
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Read", input: { file_path: "/x" } },
          { type: "tool_use", name: "Agent", input: { subagent_type: "engineer" } },
          { type: "tool_use", name: "Agent", input: { subagent_type: "security-reviewer" } },
          { type: "tool_use", name: "Agent", input: {} }, // missing subagent_type
        ],
      },
    }),
    JSON.stringify({ type: "result", subtype: "success" }),
  ].join("\n");

  const behavior = parseBehavior({ ndjson, diff: "", changedFiles: [], secrets: [token] });

  assert.equal(behavior.subAgents.count, 4);
  assert.deepEqual(behavior.subAgents.byType, {
    engineer: 2,
    "security-reviewer": 1,
    "(unknown)": 1,
  });
  assert.equal(behavior.toolCalls.total, 6); // Bash + 3 Agent + Read + 1 Agent
  assert.equal(behavior.toolCalls.byName["Agent"], 4);
  assert.equal(behavior.toolCalls.byName["Bash"], 1);
  assert.equal(behavior.toolCalls.byName["Read"], 1);

  // The leaked token in the free-text description must be scrubbed.
  const engineerDispatch = behavior.subAgents.dispatches.find((d) => d.description);
  assert.ok(engineerDispatch);
  assert.doesNotMatch(engineerDispatch.description!, /sk-ant/);
  assert.match(engineerDispatch.description!, /\[REDACTED-CREDENTIAL\]/);
});

test("parseBehavior redacts secrets smuggled into subagent_type and tool names", () => {
  const token = "sk-ant-oat01-SMUGGLED9876543210";
  const ndjson = JSON.stringify({
    type: "assistant",
    message: {
      content: [
        // Agent-controlled subagent_type carrying the token.
        { type: "tool_use", name: "Agent", input: { subagent_type: `engineer-${token}` } },
        // A task-definable (MCP) tool name carrying the token.
        { type: "tool_use", name: `mcp__${token}__do`, input: {} },
      ],
    },
  });

  const behavior = parseBehavior({ ndjson, diff: "", changedFiles: [], secrets: [token] });

  const serialized = JSON.stringify(behavior);
  assert.doesNotMatch(serialized, /sk-ant/, "no raw token may reach the persisted behavior object");
  // The redaction marker lands in both the byType key and the byName key.
  assert.ok(Object.keys(behavior.subAgents.byType).some((k) => k.includes("[REDACTED-CREDENTIAL]")));
  assert.ok(Object.keys(behavior.toolCalls.byName).some((k) => k.includes("[REDACTED-CREDENTIAL]")));
});

test("parseBehavior parses diff LOC churn and counts added test cases in test files only", () => {
  const changedFiles: ChangedFile[] = [
    { path: "src/handler.ts", kind: "source" },
    { path: "src/handler.test.ts", kind: "test" },
  ];
  const diff = [
    "diff --git a/src/handler.ts b/src/handler.ts",
    "index 111..222 100644",
    "--- a/src/handler.ts",
    "+++ b/src/handler.ts",
    "@@ -1,2 +1,3 @@",
    " context line",
    "+export function handle() { return it_is_fine(); }", // added source line (matches it( ? no)
    "-const old = 1;",
    "diff --git a/src/handler.test.ts b/src/handler.test.ts",
    "index 333..444 100644",
    "--- a/src/handler.test.ts",
    "+++ b/src/handler.test.ts",
    "@@ -0,0 +1,4 @@",
    '+it("does a thing", () => {});',
    '+test("does another", () => {});',
    "+const helper = 1;",
    "-removed from test",
  ].join("\n");

  const behavior = parseBehavior({ diff, ndjson: "", changedFiles, secrets: [] });

  assert.equal(behavior.changedFileShape.source, 1);
  assert.equal(behavior.changedFileShape.test, 1);
  assert.equal(behavior.changedFileShape.docs, 0);
  // Added: 1 source + 3 test lines = 4; the +++ headers are excluded.
  assert.equal(behavior.changedFileShape.linesAdded, 4);
  // Removed: 1 source + 1 test = 2; the --- headers are excluded.
  assert.equal(behavior.changedFileShape.linesRemoved, 2);
  // Only the two it()/test() calls inside the test file count.
  assert.equal(behavior.testCasesAdded, 2);
  assert.deepEqual(behavior.touchedFiles, ["src/handler.ts", "src/handler.test.ts"]);
});

test("parseBehavior diffHash is stable for fixed input and changes with content", () => {
  const a = parseBehavior({ diff: "+line one\n-line two", ndjson: "", changedFiles: [], secrets: [] });
  const b = parseBehavior({ diff: "+line one\n-line two", ndjson: "", changedFiles: [], secrets: [] });
  assert.equal(a.diffHash, b.diffHash);
  assert.match(a.diffHash, /^[0-9a-f]{64}$/);
  const c = parseBehavior({ diff: "+different", ndjson: "", changedFiles: [], secrets: [] });
  assert.notEqual(a.diffHash, c.diffHash);
});
