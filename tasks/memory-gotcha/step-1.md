Add a SCREAMING_SNAKE_CASE helper to the string-case module.

You are working in the `strcase-kit` project. The case helpers live in
`src/strcase.mjs` (currently `toKebab` and `toSnake`).

## Requirement

In `src/strcase.mjs`, add and export a function:

```js
toScreamingSnake(input) // -> string
```

- It returns the SCREAMING_SNAKE_CASE form of the input: the same segmentation as
  `toSnake`, but upper-cased. For example `toScreamingSnake("Hello World")`
  returns `"HELLO_WORLD"` and `toScreamingSnake("fooBarBaz")` returns
  `"FOO_BAR_BAZ"`.
- Build on the existing `toSnake` helper rather than re-deriving the segmentation.

Add a unit test for `toScreamingSnake` (put it in `src/strcase.test.mjs`) covering
a couple of inputs.

The test suite must be green: `npm test` has to pass before you are done.
