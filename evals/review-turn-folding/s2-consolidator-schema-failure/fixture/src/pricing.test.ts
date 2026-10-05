import { applyBulkDiscount } from "./pricing";

describe("applyBulkDiscount", () => {
  it("discounts a large cart", () => {
    expect(applyBulkDiscount(200)).toBe(180);
  });
});
