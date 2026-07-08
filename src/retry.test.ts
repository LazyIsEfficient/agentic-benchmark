import assert from "node:assert/strict";
import { test } from "node:test";
import { withRetry } from "./retry.js";

/** A no-op sleep that records the delays it was asked to wait, for assertions. */
function recordingSleep() {
  const delays: number[] = [];
  const fn = async (ms: number) => {
    delays.push(ms);
  };
  return { fn, delays };
}

test("withRetry: success on attempt 1 runs once and never sleeps", async () => {
  const sleep = recordingSleep();
  let calls = 0;
  const { value, attempts } = await withRetry(
    async () => {
      calls++;
      return "ok";
    },
    { maxAttempts: 3, baseMs: 2000, sleep: sleep.fn },
  );
  assert.equal(value, "ok");
  assert.equal(attempts, 1);
  assert.equal(calls, 1);
  assert.deepEqual(sleep.delays, []);
});

test("withRetry: succeeds on attempt 2, reports 2 attempts, sleeps once with base delay", async () => {
  const sleep = recordingSleep();
  let calls = 0;
  const retries: number[] = [];
  const { value, attempts } = await withRetry(
    async () => {
      calls++;
      if (calls < 2) throw new Error("transient");
      return 42;
    },
    {
      maxAttempts: 3,
      baseMs: 2000,
      sleep: sleep.fn,
      onRetry: (failedAttempt) => retries.push(failedAttempt),
    },
  );
  assert.equal(value, 42);
  assert.equal(attempts, 2);
  assert.equal(calls, 2);
  assert.deepEqual(sleep.delays, [2000]); // backoff after attempt 1
  assert.deepEqual(retries, [1]); // onRetry fired once for the failed attempt 1
});

test("withRetry: always-fails throws the last error after maxAttempts with backoff", async () => {
  const sleep = recordingSleep();
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        throw new Error(`fail-${calls}`);
      },
      { maxAttempts: 3, baseMs: 2000, sleep: sleep.fn },
    ),
    /fail-3/, // the LAST error surfaces
  );
  assert.equal(calls, 3);
  assert.deepEqual(sleep.delays, [2000, 4000]); // exponential, no sleep after the last attempt
});
