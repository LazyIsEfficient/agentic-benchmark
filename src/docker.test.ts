import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { CONTAINER_WORK_DIR, IMAGE_NAME } from "./config.js";
import { runContainer, runTests, type SpawnFn } from "./docker.js";

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

// --- runTests (deterministic Correctness axis) --------------------------------

/** Like fakeSpawn, but records every spawn's argv for arg-construction asserts. */
function recordingSpawn(runChild: FakeChild, calls: string[][]): SpawnFn {
  return ((_cmd: string, args: string[]) => {
    calls.push(args);
    return args[0] === "run" ? runChild : new EventEmitter();
  }) as unknown as SpawnFn;
}

/** Drive runTests against a fake docker client that emits `stdout`/`stderr` and
 *  exits with `exitCode`. */
async function runTestsWith(
  output: { stdout?: string; stderr?: string },
  exitCode: number,
  command = "npm test",
) {
  const child = new FakeChild();
  const fn = fakeSpawn(child);
  setTimeout(() => {
    if (output.stdout) child.stdout.emit("data", Buffer.from(output.stdout));
    if (output.stderr) child.stderr.emit("data", Buffer.from(output.stderr));
    child.emit("close", exitCode);
  }, 1);
  return runTests({ workspaceDir: "/host/ws", command, timeoutMs: 5000, spawnFn: fn });
}

test("runTests: executor-identical mount/image, sh -lc command, NO auth env", async () => {
  const child = new FakeChild();
  const calls: string[][] = [];
  const fn = recordingSpawn(child, calls);
  setTimeout(() => {
    child.stdout.emit("data", Buffer.from("# pass 1\n# fail 0\n"));
    child.emit("close", 0);
  }, 1);

  const res = await runTests({
    workspaceDir: "/host/ws",
    command: "npm test",
    timeoutMs: 5000,
    spawnFn: fn,
  });

  const args = calls[0]!;
  // docker run --rm -i --name <uuid> …everything after the name is ours to pin.
  assert.deepEqual(args.slice(0, 4), ["run", "--rm", "-i", "--name"]);
  assert.deepEqual(args.slice(5), [
    "-v",
    `/host/ws:${CONTAINER_WORK_DIR}`,
    "-w",
    CONTAINER_WORK_DIR,
    IMAGE_NAME,
    "sh",
    "-lc",
    "npm test",
  ]);
  // No claude CLI and no auth surface: task-authored test code must never see
  // the OAuth token, and the command needs no API access.
  assert.ok(!args.includes("-e"), "no env vars should be injected");
  assert.ok(!args.includes("claude"));
  assert.equal(res.ok, true);
  assert.equal(res.command, "npm test");
});

test("runTests: node:test TAP counts (# pass / # fail); non-zero exit ⇒ ok:false", async () => {
  const res = await runTestsWith({ stdout: "# tests 5\n# pass 4\n# fail 1\n" }, 1);
  assert.equal(res.passed, 4);
  assert.equal(res.failed, 1);
  assert.equal(res.ok, false);
});

test("runTests: jest/vitest summary with failures (combined stdout+stderr)", async () => {
  // Jest writes its summary to stderr — parsing must see the combined stream.
  const res = await runTestsWith({ stderr: "Tests:       2 failed, 3 passed, 5 total\n" }, 1);
  assert.equal(res.passed, 3);
  assert.equal(res.failed, 2);
  assert.equal(res.ok, false);
});

test("runTests: jest clean run — failed count is omitted from output, so stays undefined", async () => {
  const res = await runTestsWith({ stdout: "Tests:       7 passed, 7 total\n" }, 0);
  assert.equal(res.passed, 7);
  assert.equal(res.failed, undefined, "a count not literally in the output is never fabricated");
  assert.equal(res.ok, true);
});

test("runTests: mocha epilogue (N passing / N failing)", async () => {
  const res = await runTestsWith({ stdout: "  12 passing (48ms)\n  3 failing\n" }, 1);
  assert.equal(res.passed, 12);
  assert.equal(res.failed, 3);
  assert.equal(res.ok, false);
});

test("runTests: unparseable output ⇒ counts undefined, ok still tracks exit code", async () => {
  const res = await runTestsWith({ stdout: "ran fine, trust me\n" }, 0);
  assert.equal(res.passed, undefined);
  assert.equal(res.failed, undefined);
  assert.equal(res.ok, true);
  assert.match(res.raw ?? "", /trust me/);
});

test("runTests: first matching runner format wins (TAP over a mocha-looking line)", async () => {
  const res = await runTestsWith({ stdout: "# pass 2\n# fail 0\n99 passing\n" }, 0);
  assert.equal(res.passed, 2, "TAP matched first; the mocha-style line is ignored");
  assert.equal(res.failed, 0);
});

test("runTests: timeout ⇒ ok:false and raw notes the timeout", async () => {
  // kill() schedules close(null), modelling `docker kill` stopping the container.
  const child = new FakeChild((self) => setImmediate(() => self.emit("close", null)));
  const fn = fakeSpawn(child);
  const res = await runTests({
    workspaceDir: "/host/ws",
    command: "npm test",
    timeoutMs: 10,
    spawnFn: fn,
  });
  assert.equal(res.ok, false);
  assert.match(res.raw ?? "", /timed out after 10ms/);
  assert.equal(res.passed, undefined);
  assert.equal(res.failed, undefined);
});

test("runTests: raw is capped to the LAST 4KB of combined output", async () => {
  const res = await runTestsWith({ stdout: "x".repeat(5000) + "TAIL-MARKER" }, 0);
  assert.equal(res.raw?.length, 4096);
  assert.ok(res.raw?.endsWith("TAIL-MARKER"), "the tail (where summaries live) is kept");
});
