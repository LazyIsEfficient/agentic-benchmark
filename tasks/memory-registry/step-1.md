Add a new command handler to the command bus.

You are working in the `command-bus` project. Commands are handled by small pure
functions in `src/handlers/`, and the dispatcher in `src/dispatch.ts` routes a
command name to its handler by looking it up in `src/registry.ts`.

## Requirement

Add a handler named `echo` in `src/handlers/echo.ts`:

```ts
export const echo: Handler = (arg: string): string => /* returns arg unchanged */;
```

- It takes the command argument and returns it unchanged.
- Reuse the exported `Handler` type from `src/handler.ts`.

NOTE — project convention: in this codebase **every handler MUST be registered in
`src/registry.ts`**. After you create the handler, add it to the `registry` map
there (keyed by its command name, `"echo"`) so the dispatcher can route to it.
This is a hard rule for every handler we add.

Add a unit test covering the `echo` handler.
