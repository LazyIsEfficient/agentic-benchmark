import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { HORIZON_MS } from "./config.js";
import { buildRunFolderName, isoStamp, revTimeKey, shortId } from "./runmeta.js";

const WIDTH = String(HORIZON_MS).length;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

test("revTimeKey: a newer run sorts lexically BEFORE an older one", () => {
  const older = revTimeKey(1_000_000_000_000);
  const newer = revTimeKey(2_000_000_000_000);
  assert.ok(newer < older, `${newer} should sort before ${older}`);
});

test("revTimeKey: fixed width, zero-padded", () => {
  assert.equal(revTimeKey(Date.now()).length, WIDTH);
  assert.equal(revTimeKey(1).length, WIDTH);
  // A very recent time still pads to the full width.
  assert.match(revTimeKey(Date.now()), new RegExp(`^\\d{${WIDTH}}$`));
});

test("isoStamp: filesystem-safe UTC (no colons, no ms)", () => {
  assert.equal(isoStamp(Date.UTC(2026, 6, 8, 15, 30, 0)), "2026-07-08T15-30-00Z");
});

test("shortId: first 8 hex chars of the GUID", () => {
  assert.equal(shortId("1e2f3a4b-5c6d-7e8f-9a0b-1c2d3e4f5a6b"), "1e2f3a4b");
  const id = randomUUID();
  assert.match(id, UUID_RE); // runId is a valid UUID
  assert.equal(shortId(id).length, 8);
  assert.equal(shortId(id), id.replace(/-/g, "").slice(0, 8));
});

test("buildRunFolderName: shape is revkey__iso__short8", () => {
  const name = buildRunFolderName(
    "1e2f3a4b-5c6d-7e8f-9a0b-1c2d3e4f5a6b",
    Date.UTC(2026, 6, 8, 15, 30, 0),
  );
  assert.match(name, new RegExp(`^\\d{${WIDTH}}__\\d{4}-\\d\\d-\\d\\dT\\d\\d-\\d\\d-\\d\\dZ__[0-9a-f]{8}$`));
  assert.ok(name.endsWith("__1e2f3a4b"));
});

test("buildRunFolderName: newer run folder sorts first under ascending name sort", () => {
  const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const older = buildRunFolderName(id, Date.UTC(2026, 0, 1));
  const newer = buildRunFolderName(id, Date.UTC(2026, 6, 8));
  assert.deepEqual([older, newer].sort(), [newer, older]);
});
