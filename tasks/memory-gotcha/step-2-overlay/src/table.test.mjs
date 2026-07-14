import test from "node:test";
import assert from "node:assert/strict";
import { toKebab } from "./strcase.mjs";
import { KEBAB_CASES } from "./generated/fixtures.gen.mjs";

test("toKebab matches every generated fixture case", () => {
  for (const [input, expected] of KEBAB_CASES) {
    assert.equal(toKebab(input), expected);
  }
});
