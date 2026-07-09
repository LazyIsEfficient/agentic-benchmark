Add a dot.case helper to the string-case module.

Still in the `strcase-kit` project, extend `src/strcase.mjs`.

## Requirement

In `src/strcase.mjs`, add and export a function:

```js
toDotCase(input) // -> string
```

- It returns the dot.case form of the input: the same segmentation as `toKebab`,
  but joined with `.` instead of `-`. For example `toDotCase("Hello World")`
  returns `"hello.world"` and `toDotCase("fooBarBaz")` returns `"foo.bar.baz"`.
- Build on the existing `toKebab` helper rather than re-deriving the segmentation.

Add a unit test for `toDotCase` (put it in `src/strcase.test.mjs`) covering a
couple of inputs.

The test suite must be green: `npm test` has to pass before you are done.
