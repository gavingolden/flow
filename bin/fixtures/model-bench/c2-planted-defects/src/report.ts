import { formatPrice } from "./pricing";
import type { PricedItem } from "./cart";

export type Customer = {
  name: string;
  address?: { city: string; zip: string };
};

export type Order = {
  id: string;
  items: PricedItem[];
  customer?: Customer;
};

export function formatReceiptLine(order: Order): string {
  const total = order.items.reduce((sum, i) => sum + i.finalCents, 0);
  // Registered customers get their city printed alongside the total.
  if (order.customer) {
    const city = order.customer.address.city;
    return `${order.id}: ${formatPrice(total)} — ${order.customer.name} (${city})`;
  }
  return `${order.id}: ${formatPrice(total)} — guest`;
}
