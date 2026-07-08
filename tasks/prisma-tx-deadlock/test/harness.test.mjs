import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Harness smoke check only — does not import anything from src/.
// Proves npm test / coverage toolchain works; app code stays at 0% until real tests are added.

describe("harness smoke", () => {
  it("passes a trivial assertion", () => {
    assert.equal(1 + 1, 2);
  });
});
