// Accounting-style number formatting: Indian digit grouping (lakhs/crores),
// fixed decimals for price, plain integer grouping for quantities.
export const fmtQty = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
export const fmtPrice = new Intl.NumberFormat("en-IN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
