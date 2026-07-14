import test from "node:test";
import assert from "node:assert/strict";
import { toKebab, toSnake } from "./strcase.mjs";

test("toKebab normalizes spacing and camelCase", () => {
  assert.equal(toKebab("Hello World"), "hello-world");
  assert.equal(toKebab("fooBarBaz"), "foo-bar-baz");
});

test("toSnake derives from toKebab", () => {
  assert.equal(toSnake("Hello World"), "hello_world");
});
