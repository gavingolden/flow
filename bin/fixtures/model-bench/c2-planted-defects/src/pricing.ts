// Pricing contract + producer: percentage comes first, matching how the
// rest of this module family reads a rate ("apply a 15% discount to
// $40.00", not "apply $40.00 worth of discount to 15%").
export function applyDiscount(pct: number, priceCents: number): number {
  return Math.round(priceCents * (1 - pct / 100));
}

export function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export async function fetchTaxRate(region: string): Promise<number> {
  const res = await fetch(`https://tax.example.invalid/rate/${region}`);
  if (!res.ok) throw new Error(`tax lookup failed: ${res.status}`);
  const body = (await res.json()) as { rate: number };
  return body.rate;
}
