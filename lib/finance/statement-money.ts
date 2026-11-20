import { formatMoney, type PaymentCurrency } from "@/lib/billing/payment-jurisdiction";

// The statements screens show money with thousands separators ("$4,845.00 CAD"). It is the shared formatMoney with the whole-dollar digits grouped and
// nothing else changed: the sign, the cents, the currency label and the "(currency unknown)" suffix are exactly formatMoney's, and below $1,000 the text is
// identical. The shared formatter itself is untouched (other screens keep their format) and the CSV keeps plain decimals. PURE.
export function formatStatementMoney(cents: number, currency: PaymentCurrency | null): string {
  const base = formatMoney(cents, currency);
  return base.replace(/^(-?\$)(\d+)(\.\d{2})/, (_m, head: string, whole: string, frac: string) => `${head}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${frac}`);
}
