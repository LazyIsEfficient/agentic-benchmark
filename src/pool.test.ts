import assert from "node:assert/strict";
import { test } from "node:test";
import { runPool } from "./pool.js";

const tick = () => new Promise<void>((r) => setTimeout(r, 1));

test("runPool preserves input order regardless of completion order", async () => {
  const items = [40, 10, 30, 20, 5];
  const outcomes = await runPool(items, 3, async (n) => {
    // Later items finish sooner, so completion order != input order.
    await new Promise((r) => setTimeout(r, n));
    return n * 2;
  });
  assert.deepEqual(outcomes.map((o) => o.value), [80, 20, 60, 40, 10]);
});

test("runPool never exceeds the concurrency ceiling", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const items = Array.from({ length: 20 }, (_, i) => i);
  const N = 4;

  await runPool(items, N, async (i) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await tick();
    inFlight--;
    return i;
  });

  assert.ok(maxInFlight <= N, `maxInFlight ${maxInFlight} should be <= ${N}`);
  // With 20 items and N=4 there should genuinely be parallelism.
  assert.ok(maxInFlight > 1, "expected real parallelism");
});

test("runPool runs every item exactly once", async () => {
  const items = Array.from({ length: 15 }, (_, i) => i);
  const seen = new Set<number>();
  const outcomes = await runPool(items, 5, async (i) => {
    seen.add(i);
    await tick();
    return i;
  });
  assert.equal(seen.size, 15);
  assert.deepEqual(outcomes.map((o) => o.value), items);
});

test("runPool captures a throwing worker without aborting the rest", async () => {
  const items = [0, 1, 2, 3, 4];
  const outcomes = await runPool(items, 2, async (i) => {
    await tick();
    if (i === 2) throw new Error(`boom-${i}`);
    return i * 10;
  });

  // Item 2 captured as an error; every other item still produced a value.
  assert.equal(outcomes[2]!.value, undefined);
  assert.match(outcomes[2]!.error!.message, /boom-2/);
  assert.deepEqual(
    [outcomes[0]!, outcomes[1]!, outcomes[3]!, outcomes[4]!].map((o) => o.value),
    [0, 10, 30, 40],
  );
});

test("runPool handles an empty item list", async () => {
  const outcomes = await runPool([], 4, async () => 1);
  assert.deepEqual(outcomes, []);
});

test("runPool with concurrency 1 is fully sequential", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  await runPool([1, 2, 3], 1, async (i) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await tick();
    inFlight--;
    return i;
  });
  assert.equal(maxInFlight, 1);
});
