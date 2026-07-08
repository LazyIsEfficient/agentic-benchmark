import assert from "node:assert/strict";
import { test } from "node:test";
import { pickToken } from "./auth.js";

test("pickToken: env value wins over the file value", () => {
  assert.equal(pickToken("env-token", "file-token"), "env-token");
});

test("pickToken: env value is trimmed", () => {
  assert.equal(pickToken("  env-token  ", null), "env-token");
});

test("pickToken: falls back to the file when env is unset or blank", () => {
  assert.equal(pickToken(undefined, "file-token"), "file-token");
  assert.equal(pickToken("", "file-token"), "file-token");
  assert.equal(pickToken("   ", "file-token"), "file-token");
  assert.equal(pickToken(undefined, "  file-token\n"), "file-token");
});

test("pickToken: throws a clear error when neither source has a token", () => {
  assert.throws(() => pickToken(undefined, null), /No Claude OAuth token found/);
  assert.throws(() => pickToken("", ""), /No Claude OAuth token found/);
  assert.throws(() => pickToken("   ", "   "), /No Claude OAuth token found/);
});
