import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { runContainer, type SpawnFn } from "./docker.js";

/**
 * Minimal ChildProcess stand-in. `closeBehavior` controls when/if it emits
 * `close`, letting us model a clean exit, a kill that works, or a hung client.
 */
class FakeChild extends EventEmitter {
  stdin = { on: () => this.stdin, write: () => true, end: () => {} };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killCount = 0;
  constructor(private onKill: (self: FakeChild) => void = () => {}) {
    super();
  }
  kill(): boolean {
    this.killCount++;
    this.onKill(this);
    return true;
  }
}

/**
 * Injectable spawn: returns `runChild` for the `docker run` invocation and a
 * no-op EventEmitter stub for the fire-and-forget `docker kill <name>` spawn.
 */
function fakeSpawn(runChild: FakeChild): SpawnFn {
  return ((_cmd: string, args: string[]) =>
    args[0] === "run" ? runChild : new EventEmitter()) as unknown as SpawnFn;
}

const baseOpts = { dockerArgs: [], command: ["claude"], stdin: "hi" };

test("runContainer resolves on a clean close (happy path, no timeout)", async () => {
  const child = new FakeChild();
  const fn = fakeSpawn(child);
  setTimeout(() => {
    child.stdout.emit("data", Buffer.from("out"));
    child.emit("close", 0);
  }, 1);

  const res = await runContainer({ ...baseOpts, timeoutMs: 5000, graceMs: 5000, spawnFn: fn });
  assert.equal(res.exitCode, 0);
  assert.equal(res.timedOut, false);
  assert.equal(res.stdout, "out");
});

test("runContainer: timeout + a kill that works resolves as timedOut via close", async () => {
  // kill() schedules a close(null), modelling `docker kill` actually stopping it.
  const child = new FakeChild((self) => setImmediate(() => self.emit("close", null)));
  const fn = fakeSpawn(child);

  const res = await runContainer({ ...baseOpts, timeoutMs: 10, graceMs: 500, spawnFn: fn });
  assert.equal(res.timedOut, true);
  assert.equal(res.exitCode, null);
  assert.ok(child.killCount >= 1, "SIGKILL should have been sent to the run client");
});

test("runContainer: a hung client is force-resolved within the grace window", async () => {
  // kill() does nothing and `close` is never emitted → grace backstop must fire.
  const child = new FakeChild();
  const fn = fakeSpawn(child);

  const t0 = Date.now();
  const res = await runContainer({ ...baseOpts, timeoutMs: 10, graceMs: 30, spawnFn: fn });
  const elapsed = Date.now() - t0;

  assert.equal(res.timedOut, true);
  assert.equal(res.exitCode, null);
  assert.ok(child.killCount >= 1);
  // Bounded to ≈ timeout + grace (allow generous headroom for CI timers).
  assert.ok(elapsed < 500, `elapsed ${elapsed}ms should be well under timeout+grace+slack`);
});

test("runContainer: a late close after force-resolve does not double-resolve", async () => {
  const child = new FakeChild();
  const fn = fakeSpawn(child);
  const res = await runContainer({ ...baseOpts, timeoutMs: 10, graceMs: 20, spawnFn: fn });
  assert.equal(res.timedOut, true);
  // Emitting a late close must be a harmless no-op (settled guard).
  assert.doesNotThrow(() => child.emit("close", 0));
});
