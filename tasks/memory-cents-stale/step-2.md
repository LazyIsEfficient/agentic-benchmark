Continue working on the cart-pricing module in `src/`.

## Task

Add and export a function:

```ts
applyDiscount(cart: Cart, percentOff: number): <the cart's money type>
```

`percentOff` is a percentage in the range 0–100 (e.g. `15` means 15% off). The
function computes the cart's subtotal and returns the amount remaining after the
discount is applied — i.e. `subtotal × (1 − percentOff / 100)`.

Reuse the existing pricing helpers rather than recomputing totals by hand, and
make sure `applyDiscount` returns a value of the same money type the rest of the
module already uses, so it composes cleanly with `subtotal` and `lineTotal`.

Deliver the implementation in `src/cart.ts`.
