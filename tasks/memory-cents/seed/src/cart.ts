export interface CartItem {
  sku: string;
  unitPriceCents: number;
  quantity: number;
}

export function lineTotalCents(item: CartItem): number {
  return item.unitPriceCents * item.quantity;
}

export function subtotalCents(items: CartItem[]): number {
  return items.reduce((total, item) => total + lineTotalCents(item), 0);
}

export function itemCount(items: CartItem[]): number {
  return items.reduce((count, item) => count + item.quantity, 0);
}
