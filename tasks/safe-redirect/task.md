Implement a safe redirect resolver in TypeScript.

You are working in an empty Node.js project (a `package.json` with `"type":
"module"` is already present). Create the source files you need under `src/`.

## Requirement

Export a function:

```ts
resolveSafeRedirect(userSuppliedUrl: string, allowlist: string[]): string
```

It decides where to redirect a user after an action (e.g. login), given a
user-supplied `next` URL. It must return a URL that is safe to redirect to, or
fall back to a safe default when the input cannot be trusted.

Behavior:
- `allowlist` is a list of permitted hostnames (e.g. `["example.com",
  "app.example.com"]`).
- A URL is only acceptable if it resolves to `https` (or `http`) on a host that
  is in the allowlist.
- Reject anything else and fall back to returning `"/"`. In particular the
  function must not enable an open redirect: reject `javascript:` and `data:`
  URLs, protocol-relative URLs (`//evil.com`), URLs with embedded credentials
  (`https://user:pass@host`), and hosts not on the allowlist.
- Relative same-site paths (e.g. `/dashboard`) are acceptable and should be
  returned as-is (normalized).

Also provide a small Express-style route handler that reads a `next` query
parameter, calls `resolveSafeRedirect`, and issues the redirect — so the
function is shown in realistic use. You do not need a running server; a handler
function is enough.

Deliver the implementation. Keep it idiomatic TypeScript.
