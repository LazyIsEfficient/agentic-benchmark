import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractLastResultEvent,
  fmtCost,
  fmtSeconds,
  fmtTokens,
  formatExecLine,
  parseCallMetrics,
  sumModelUsage,
} from "./metrics.js";

const fullResult = {
  type: "result",
  subtype: "success",
  duration_ms: 78_400,
  duration_api_ms: 60_000,
  num_turns: 12,
  total_cost_usd: 0.1234,
  usage: {
    input_tokens: 45_200,
    output_tokens: 3_100,
    cache_creation_input_tokens: 100,
    cache_read_input_tokens: 900,
  },
};

test("parseCallMetrics maps a full result event (snake_case → camelCase)", () => {
  const m = parseCallMetrics(fullResult, 80_000);
  assert.equal(m.wallMs, 80_000);
  assert.equal(m.durationMs, 78_400);
  assert.equal(m.apiMs, 60_000);
  assert.equal(m.numTurns, 12);
  assert.equal(m.costUsd, 0.1234);
  assert.deepEqual(m.usage, {
    inputTokens: 45_200,
    outputTokens: 3_100,
    cacheReadTokens: 900,
    cacheCreateTokens: 100,
  });
});

test("sumModelUsage sums per-model full-session totals", () => {
  assert.deepEqual(
    sumModelUsage({
      "claude-sonnet-5": {
        inputTokens: 105,
        outputTokens: 40_000,
        cacheReadInputTokens: 1_000,
        cacheCreationInputTokens: 200,
      },
      "claude-haiku-4-5": {
        inputTokens: 10,
        outputTokens: 329,
        cacheReadInputTokens: 50,
        cacheCreationInputTokens: 5,
      },
    }),
    {
      inputTokens: 115,
      outputTokens: 40_329,
      cacheReadTokens: 1_050,
      cacheCreateTokens: 205,
    },
  );
  assert.equal(sumModelUsage(undefined), null);
  assert.equal(sumModelUsage({}), null);
  assert.equal(sumModelUsage({ "claude-sonnet-5": {} }), null);
});

test("parseCallMetrics falls back to usage when modelUsage entries are hollow", () => {
  const m = parseCallMetrics(
    {
      ...fullResult,
      modelUsage: { "claude-sonnet-5": {} },
    },
    80_000,
  );
  assert.deepEqual(m.usage, {
    inputTokens: 45_200,
    outputTokens: 3_100,
    cacheReadTokens: 900,
    cacheCreateTokens: 100,
  });
});

test("parseCallMetrics prefers modelUsage over last-turn usage (includes subagents)", () => {
  const m = parseCallMetrics(
    {
      ...fullResult,
      usage: {
        input_tokens: 16,
        output_tokens: 2_755,
        cache_creation_input_tokens: 5_967,
        cache_read_input_tokens: 667_804,
      },
      modelUsage: {
        "claude-sonnet-5": {
          inputTokens: 105,
          outputTokens: 46_329,
          cacheReadInputTokens: 3_116_084,
          cacheCreationInputTokens: 128_156,
          costUSD: 2.25099945,
        },
      },
    },
    80_000,
  );
  assert.deepEqual(m.usage, {
    inputTokens: 105,
    outputTokens: 46_329,
    cacheReadTokens: 3_116_084,
    cacheCreateTokens: 128_156,
  });
  // cost/turns still come from the result envelope, not modelUsage
  assert.equal(m.costUsd, 0.1234);
  assert.equal(m.numTurns, 12);
});

test("parseCallMetrics: missing usage/cost → undefined, wallMs preserved", () => {
  const m = parseCallMetrics({ type: "result", num_turns: 1 }, 4_200);
  assert.equal(m.wallMs, 4_200);
  assert.equal(m.numTurns, 1);
  assert.equal(m.costUsd, undefined);
  assert.equal(m.durationMs, undefined);
  assert.equal(m.usage, undefined);
});

test("parseCallMetrics: usage sub-fields default to 0 when absent", () => {
  const m = parseCallMetrics({ type: "result", usage: { input_tokens: 5 } }, 100);
  assert.deepEqual(m.usage, {
    inputTokens: 5,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
  });
});

test("parseCallMetrics: non-object event → only wallMs", () => {
  const m = parseCallMetrics(null, 999);
  assert.deepEqual(m, { wallMs: 999 });
});

test("extractLastResultEvent returns the last result line from a stream-json blob", () => {
  const ndjson = [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }),
    JSON.stringify({ type: "result", subtype: "error_max_turns", total_cost_usd: 0.01 }),
    JSON.stringify({ type: "result", subtype: "success", total_cost_usd: 0.09 }),
    "", // trailing blank line
  ].join("\n");
  const evt = extractLastResultEvent(ndjson) as Record<string, unknown>;
  assert.equal(evt["subtype"], "success");
  assert.equal(evt["total_cost_usd"], 0.09);
});

test("extractLastResultEvent returns null when there is no result line", () => {
  const ndjson = JSON.stringify({ type: "assistant", message: { content: [] } });
  assert.equal(extractLastResultEvent(ndjson), null);
});

test("extractLastResultEvent skips malformed lines", () => {
  const ndjson = ["not json", JSON.stringify({ type: "result", num_turns: 2 })].join("\n");
  const evt = extractLastResultEvent(ndjson) as Record<string, unknown>;
  assert.equal(evt["num_turns"], 2);
});

test("formatters humanize and render em dash for missing values", () => {
  assert.equal(fmtSeconds(78_400), "78.4s");
  assert.equal(fmtSeconds(undefined), "—");
  assert.equal(fmtTokens(45_200), "45.2k");
  assert.equal(fmtTokens(undefined), "—");
  assert.equal(fmtCost(0.1234), "$0.1234");
  assert.equal(fmtCost(undefined), "—");
});

test("formatExecLine composes a compact one-liner and omits absent fields", () => {
  const full = formatExecLine(parseCallMetrics(fullResult, 80_000));
  assert.equal(full, "[exec 80.0s, $0.1234, 45.2k in / 3.1k out, 12 turns]");

  const bare = formatExecLine({ wallMs: 3_000 });
  assert.equal(bare, "[exec 3.0s]");
});
