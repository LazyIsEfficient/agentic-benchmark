Add flat-rate shipping to the cart module.

We're introducing a single flat shipping fee for every order. In `src/cart.ts`:

1. Add a `FLAT_SHIPPING_FEE` constant for the standard shipping charge of $5.99.
2. Export a function:

   ```ts
   orderTotalWithShipping(items: CartItem[]): number
   ```

   It returns the cart's subtotal plus the flat shipping fee. Build on the
   existing subtotal helper in the module rather than recomputing it from
   scratch.

Add a unit test covering the total-with-shipping result for a small cart.
