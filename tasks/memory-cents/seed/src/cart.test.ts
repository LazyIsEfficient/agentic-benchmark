import { describe, expect, it } from "vitest";
import { itemCount, lineTotalCents, subtotalCents, type CartItem } from "./cart.js";

const items: CartItem[] = [
  { sku: "MUG-01", unitPriceCents: 1299, quantity: 2 },
  { sku: "PEN-04", unitPriceCents: 350, quantity: 3 },
];

describe("cart", () => {
  it("computes a line total", () => {
    expect(lineTotalCents(items[0])).toBe(2598);
  });

  it("computes the subtotal", () => {
    expect(subtotalCents(items)).toBe(3648);
  });

  it("counts items", () => {
    expect(itemCount(items)).toBe(5);
  });
});
