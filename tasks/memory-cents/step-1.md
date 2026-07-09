Add percentage-discount support to the cart module.

You are working in the `checkout-cart` project. The cart math lives in
`src/cart.ts` (items, line totals, subtotal). We are running a promotion and need
to apply a whole-number percentage discount to a cart's subtotal.

## Requirement

In `src/cart.ts`, export a function:

```ts
discountedSubtotalCents(items: CartItem[], percentOff: number): number
```

- `percentOff` is a whole-number percentage (e.g. `10` means 10% off, `25` means
  25% off). Assume it is in the range `0`–`100`.
- It returns the cart subtotal after the discount is applied, rounded to the
  nearest cent.
- Reuse the existing `subtotalCents` helper rather than re-deriving the subtotal.

Note: in this codebase all monetary values are stored and computed as **integer
cents** — never floating-point dollars. Every amount that enters or leaves the
cart module is an integer count of cents, and any new money value you introduce
must follow the same convention.

Add a couple of unit tests covering the discount math (including rounding).
