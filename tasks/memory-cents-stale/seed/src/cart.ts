export interface CartItem {
  name: string;
  unitPrice: number;
  quantity: number;
}

export interface Cart {
  items: CartItem[];
}

export function lineTotal(item: CartItem): number {
  return item.unitPrice * item.quantity;
}
