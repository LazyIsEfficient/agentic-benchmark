import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Harness smoke check only — does not import anything from src/.
// Proves npm test / coverage toolchain works with 0% application coverage.

describe("test harness", () => {
  it("runs under node:test", () => {
    assert.equal(1 + 1, 2);
  });
});
