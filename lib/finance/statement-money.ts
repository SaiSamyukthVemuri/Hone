import { formatMoney, type PaymentCurrency } from "@/lib/billing/payment-jurisdiction";

// The statements screens show money with thousands separators ("$4,845.00 CAD"). It is the shared formatMoney with the whole-dollar digits grouped and
// nothing else changed: the sign, the cents, the currency label and the "(currency unknown)" suffix are exactly formatMoney's, and below $1,000 the text is
// identical. The shared formatter itself is untouched (other screens keep their format) and the CSV keeps plain decimals. PURE.
export function formatStatementMoney(cents: number, currency: PaymentCurrency | null): string {
  const base = formatMoney(cents, currency);
  return base.replace(/^(-?\$)(\d+)(\.\d{2})/, (_m, head: string, whole: string, frac: string) => `${head}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${frac}`);
}

/** Splits a formatted amount into the figure and its trailing currency label ("$4,845.00 CAD" -> "$4,845.00" and "CAD"); text without a label is returned whole. PURE. */
export function splitCurrency(text: string): { amount: string; unit: string | null } {
  const m = /^(.*\d) ([A-Z]{3})$/.exec(text);
  return m ? { amount: m[1], unit: m[2] } : { amount: text, unit: null };
}

/** A studio-local "HH:MM" as a 12-hour clock ("09:00" -> "9:00 AM", "13:30" -> "1:30 PM"); anything that is not HH:MM is returned unchanged. PURE. */
export function formatClock12h(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return hhmm;
  const h = Number(m[1]);
  if (h > 23) return hhmm;
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h < 12 ? "AM" : "PM"}`;
}
