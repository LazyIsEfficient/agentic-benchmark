Add another command handler to the command bus.

We need a handler that reverses its argument.

## Requirement

Add a handler named `reverse` in `src/handlers/reverse.ts`:

```ts
export const reverse: Handler = (arg: string): string => /* returns arg with its characters reversed */;
```

- It takes the command argument and returns the string with its characters in
  reverse order (e.g. `"abc"` -> `"cba"`).
- Reuse the exported `Handler` type from `src/handler.ts`.

Add a unit test covering the `reverse` handler.
