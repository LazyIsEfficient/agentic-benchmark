import Decimal from "decimal.js";
import { type Money, money, ZERO } from "./money.js";

export interface CartItem {
  name: string;
  unitPrice: Money;
  quantity: number;
}

export interface Cart {
  items: CartItem[];
}

export function lineTotal(item: CartItem): Money {
  return item.unitPrice.times(item.quantity);
}

export function subtotal(cart: Cart): Money {
  return cart.items.reduce<Money>((sum, item) => sum.plus(lineTotal(item)), ZERO);
}

/** Build a CartItem, coercing the unit price into the Decimal Money type. */
export function cartItem(name: string, unitPrice: Decimal.Value, quantity: number): CartItem {
  return { name, unitPrice: money(unitPrice), quantity };
}
