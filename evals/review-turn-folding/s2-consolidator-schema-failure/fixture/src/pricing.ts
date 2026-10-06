export const TIER_RATE = 0.1;

export function applyBulkDiscount(total: number): number {
  // bulk tier
  if (total > 100) {
    return total * (1 - TIER_RATE);
  }
  return total;
}
