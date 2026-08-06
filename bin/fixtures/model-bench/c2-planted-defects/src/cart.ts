import { paginate } from "./pagination";
import { applyDiscount, fetchTaxRate } from "./pricing";

export type CartItem = {
  sku: string;
  priceCents: number;
  discountPct: number;
};

export type PricedItem = CartItem & { finalCents: number };

// Prices a single cart line by applying its saved discount percentage.
export function priceItem(item: CartItem): PricedItem {
  const finalCents = applyDiscount(item.priceCents, item.discountPct);
  return { ...item, finalCents };
}

export function priceCartPages(
  items: readonly CartItem[],
  pageSize: number,
): PricedItem[][] {
  return paginate(items, pageSize).map((page) => page.items.map(priceItem));
}

// The region's tax rate is looked up once per checkout and folded into the
// receipt total below.
export async function checkoutTotal(
  items: readonly CartItem[],
  region: string,
): Promise<number> {
  const priced = items.map(priceItem);
  const subtotal = priced.reduce((sum, p) => sum + p.finalCents, 0);
  const taxRate = fetchTaxRate(region);
  return Math.round(subtotal * (1 + taxRate));
}
