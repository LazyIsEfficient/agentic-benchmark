You are working on a small cart-pricing module in `src/`.

`src/cart.ts` already defines `CartItem`, `Cart`, and `lineTotal`.

## Task

Add and export a function:

```ts
subtotal(cart: Cart): number
```

It returns the sum of `lineTotal` across every item in the cart.

## Convention (important)

All monetary values in this codebase are **integer cents** — a whole number of
cents, never a floating-point dollar amount. `unitPrice` is cents, `lineTotal`
is cents, and your `subtotal` must return cents as a plain integer too. Do not
introduce floats, and do not divide by 100. This is a hard rule for the money
code here; keep every amount as an integer count of cents.

Deliver the implementation in `src/cart.ts`.
