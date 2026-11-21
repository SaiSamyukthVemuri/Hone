// ===========================================================================
// Business → Analytics: MONEY DISPLAY. PURE. Analytics-local; the shared formatMoney is not touched.
// ===========================================================================
// Two forms, both with thousands separators and no currency word (the page says the currency once, in the footer and the chart captions):
//   formatExact: every cent, "$1,461.70". Tables, chart data, the reconciliation, differences. The CSV does not use this: it writes plain decimal amounts.
//   formatWhole: whole dollars, "$1,462", for the four headline cards only. This is DISPLAY ONLY: nothing is computed from a rounded value, and the exact
//   figure is on the same page in the reconciliation and the chart data. Half a dollar rounds away from zero.

// The "$" sign assumes a dollar currency (CAD and USD, the two a studio can be set to today). A studio in a currency that is not written with "$" needs its own
// symbol here before it is offered; until then the currency word on the page and in the CSV is what says which currency the figures are in.
const group =(digits: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

export function formatExact(cents: number): string {
  const abs = Math.abs(cents);
  const dollars = Math.trunc(abs / 100);
  return `${cents < 0 ? "-" : ""}$${group(String(dollars))}.${String(abs % 100).padStart(2, "0")}`;
}

export function formatWhole(cents: number): string {
  const abs = Math.abs(cents);
  const dollars = Math.trunc(abs / 100) + (abs % 100 >= 50 ? 1 : 0);
  return `${cents < 0 && dollars !== 0 ? "-" : ""}$${group(String(dollars))}`;
}
